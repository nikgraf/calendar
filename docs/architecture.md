# Architecture

Client-only: both apps talk directly to the Google Calendar and Google
Tasks REST APIs, and to Apple Reminders and the Apple Calendar app's
calendars through EventKit. There is no server of ours; all state lives
in a local SQLite database per device and reconciles against Google /
EventKit. This document describes how the pieces fit; the hard rules that
came out of it are in `AGENTS.md`, the verified API semantics and the
testing conventions in `docs/google-sync-and-testing.md`.

## Data flow

```
React UI (desktop renderer / iOS)
  │  useAccounts / useCalendars / useEventsInRangeStable / usePendingOps
  │  useTaskLists / useTasksInRangeStable / useNow / useSearch
  │  useBackendMutations()               (packages/app-state/src/hooks.ts)
  ▼
@effect/atom-react atoms                 (packages/app-state/src/atoms.ts)
  │  Atom.runtime(Layer.succeed(AppBackend, client))
  │  reads: Atom.withReactivity([...keys])   writes: runtime.fn({reactivityKeys})
  ▼
BackendClient                            (packages/core/src/backend.ts)
  │  desktop: RpcClient over an Electron IPC frame channel
  │           (duplex protocols: packages/sync/src/rpcDuplex.ts;
  │            server side wired in apps/desktop/electron/backendHost.ts)
  │  iOS:     makeDirectBackendClient — zero-hop, same process
  ▼
AppBackendRpcs handlers                  (packages/sync/src/backendHandlers.ts)
  ▼
EventMutations / repos                   (packages/sync/src/mutations.ts,
  │                                       packages/db/src/*Repo.ts)
  ▼
SQLite (node:sqlite / op-sqlite)
```

**AI** (all on-device, no cloud): prompts, JSON schemas, normalization and
parsing live in `packages/ai` behind the `LanguageModel`, `SpeechToText`
and `TextRecognizer` seams; the pure `findFreeSlots` solver
(`packages/core/src/scheduling/`) computes free slots from the
already-synced local events. Desktop: renderer → preload IPC (the five
`model:*` channels: status, generate, prepare-speech, transcribe,
recognize-text) → main → the Swift helper child process
(`apps/desktop/helper`, Foundation Models + SpeechAnalyzer + Vision over
newline-JSON stdio; spawned lazily and supervised with restart backoff by
`apps/desktop/electron/helperProcess.ts`). iOS reaches the same models via
`@react-native-ai/apple` and Vision through the `solunivo-ocr` Expo
module. Dictation audio is captured by the UI layer (renderer
`getUserMedia` → 16 kHz WAV) and only transcribed natively.

**Native bridges** (`packages/reminders`, `packages/apple-calendar`,
`packages/contacts`, `packages/geo`): each is one JSON protocol spoken by
one Swift source, symlinked into the desktop helper (`callHelper('x.*')`
over stdio) and into a local Expo module (`apps/ios/modules/solunivo-*`).
Reminders are mirrored into the tasks table by the sync pass; Apple
calendars are mirrored into the calendars table and their events are
**read through** (the `getEventsInRange` handler merges the Google window
with a live EventKit query for the same range, `AppleCalendarEvents`);
device contacts are held in memory for the invitee typeahead and never
written to SQLite; MapKit answers typeahead, geocoding and map snapshots
on demand. Writes go to EventKit first and mirror the result (no pending
op — EventKit is local and synchronous). The permission asks are
window-level concerns (`reminders:status` / `contacts:status` /
`appleCalendar:status` preload IPC on desktop, the On This iPhone page on
iOS); rows only ever cross the rpc seam.

**Invalidation path** (backend → UI): repo mutations invalidate Reactivity
keys (`packages/db/src/keys.ts`: `accounts`, `calendars`, `events` and
`events:<calendarId>`, `pendingOps`, `tasks`, `taskLists`, `contacts`,
`birthdays`, `locationGeo`, `syncState`, `deviceSettings:<key>`, plus
`notice:dropped` as a broadcast-only signal). `forwardingReactivity`
(`packages/db/src/reactivityForward.ts`) decorates the backend Reactivity
to also publish every key to an in-process invalidation bus; the bus feeds
the `stream: true` `invalidations` rpc, and `bindInvalidations` (atoms.ts)
replays keys into the UI runtime's Reactivity. A change written by the
sync engine in the Electron main process repaints React in the renderer
with no polling.

## Pending-op queue (offline-tolerant writes)

Every Google mutation writes SQLite optimistically, then enqueues a
`PendingOp` and kicks `processPendingOps` (semaphore-serialized, drains
due ops oldest-first). Kinds:

| kind            | eventId                       | payload/fields                   | remote call                                                                                                                      |
| --------------- | ----------------------------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `create`        | client-generated id           | full EventRecord                 | events.insert (idempotent — 409 = already landed); attendees included; `sendUpdates=all` when guests exist                       |
| `update`        | event id / instance id        | EventRecord + `attendeesChanged` | events.patch (If-Match when etag known); attendees only when flagged; `sendUpdates=all` when guests exist or the list was edited |
| `delete`        | event id / instance id        | EventRecord (the deleted row)    | events.delete (If-Match when etag known); the snapshot only names a parked conflict                                              |
| `rsvp`          | event id                      | EventRecord (attendees)          | events.patch, attendees-only body; If-Match on the queued etag, resent **without** on a 412 (never parks)                        |
| `calendarColor` | `__calendar_color__` sentinel | `colorHex`                       | calendarList.patch?colorRgbFormat=true                                                                                           |
| `move`          | master id (source calendar)   | `targetCalendarId`               | events.move?destination= (same account; organizer only; whole series)                                                            |
| `createTask`    | temp `local-…` id             | title/notes/due                  | tasks.insert (NOT idempotent — see below)                                                                                        |
| `updateTask`    | task id                       | title/notes/due                  | tasks.patch                                                                                                                      |
| `completeTask`  | task id                       | completed flag                   | tasks.patch (status + hidden reset)                                                                                              |
| `deleteTask`    | task id                       | —                                | tasks.delete (404/410 = already gone)                                                                                            |

`PendingOpSummary` in core/backend.ts has its **own kind literal** — extend
it whenever a kind is added. Rules that keep the queue correct:

- **Coalescing**: a content edit removes prior ops for the same
  (accountId, calendarId, eventId) — a shared calendar repeats its ids
  under every account — and re-enqueues (a never-sent `create` absorbs
  edits; a sent one, stamped `dispatched_at` before the insert, stays
  ahead and the edit follows it); `removeForEvent` deliberately spares
  `rsvp` and `move` ops; `calendarColor` ops coalesce **per account**
  under the sentinel. A task edit folds into an undispatched `createTask`
  and queues as `updateTask` behind a dispatched one; task updates merge
  field by field, one patch per task. Every coalesce-then-enqueue runs in
  one transaction with the drain kicked after commit (`transactional`).
- **Backoff**: transient failures retry at `30s·2^attempts`, capped at
  30 min (`retryDelayMs`); non-409 4xx (except 429) and an undecodable
  2xx are permanent → `drop`, which releases the row and broadcasts
  `notice:dropped`. A sync the user caused (`SyncEngine.syncNow`: the
  app came back, the machine woke, an account reconnected) makes waiting
  ops due at once (`retryNow`); the timed poll keeps the backoff.
- **Acks** (`settle`, one transaction with the queue check): a response is
  written to its row only while no later op of the event is queued — that
  op owns the row and its own response settles it. An `update` that lands
  moves the ops queued after it on the etag it was sent with, and the row
  a later edit still holds, to the etag it produced (`advanceBaseEtag`,
  `advanceEtag`): a second drag made while the first was in flight follows
  it instead of meeting a 412. Only an If-Match write does this — Google
  checked that etag, so nothing else changed in between; an `rsvp` does it
  when its If-Match held, one resent unchecked after a 412 moves nothing.
  An op queued _before_ the one that landed (in backoff while it overtook)
  keeps its etag and meets its 412. A create answered 409 fetches what
  Google has, so the row stops being `pending`. A `delete` answered 404
  or 410 is done and leaves the local state alone (for one occurrence
  that is the cancelled override that keeps it away). A create dropped
  for good takes a move queued behind it along, with the rows it already
  put at the destination.
- **412 Conflict** (only `update` and `delete` park): the op is **parked**,
  never dropped — unless Google's copy already yields exactly the PATCH
  body the update would send (`updateBody`: our own earlier attempt
  landed), which is done; its followers keep their etag either way. The
  drain fetches Google's copy (`events.get`; 404/410 = deleted there) and
  `markConflict` stores it in `server_payload` with `conflict_at` set; a
  failed fetch is an ordinary retry. `listDue` skips parked ops and the
  local row stays `pending`, so pulls keep skipping it and the user's
  version stays on screen. The UI reads the conflict from
  `listPendingOps` (`PendingOpSummary.conflict`: mine, theirs) — a
  persistent banner on both apps plus the queue rows — and
  `resolveConflict` settles it: **mine** unparks with `base_etag` cleared
  so the re-send overwrites Google (a parked delete also removes a copy a
  pull re-inserted meanwhile; an edit of an event Google deleted is
  re-created under a new id as a standalone event); **theirs** re-fetches
  Google's _current_ copy (the stored one is a preview) and writes it in
  ack mode, then drops the op. Take-theirs is refused while a move of the
  series is queued ahead. A new edit of a parked event coalesces as usual
  and parks again with the newer payload.
- **401**: the op stays queued, the account is flagged `reauth_required`;
  reconnecting (same account id, resolved by email) resets status and the
  queue drains at once.
- **Provider dispatch**: `completeTask/createTask/deleteTask/updateTask`
  look up the account's provider. Google lists take the queue; Apple lists
  call EventKit synchronously via `reminderMutations` and write the result
  through (`upsertTasks`), so a created reminder has its real id from the
  start. Reminders-only fields (time, priority, url, alarms, recurrence,
  `moveToListId`) on a Google list fail with `UnsupportedForProviderError`.
  `updateTask` cannot clear a stored due day; only a create may be undated.
- **Task moves** (`moveTask`, the task twin of `moveEvent`): between two
  Reminders lists EventKit changes the list in place; every other route —
  Reminders ↔ Google and Google → another Google list or account — creates
  the task in the target from the editor's draft and then deletes the
  source, so a failure in between leaves a duplicate, never a lost task.
  Completion follows the task. What a route drops is computed in core
  (`taskMoveLoss`) from the source record and confirmed in the editor
  before anything is written.
- **Conversions** (`convertEventToTask`, `convertTaskToEvent`): an event
  becomes a task (the whole series for a recurring one) or a task an event
  by creating the other kind from the editor's draft and then deleting the
  source — the same copy-then-delete as a cross-provider move, through the
  shared `crossStore` ordering (Google → Google in one transaction; toward
  Google the queued create first, then the EventKit delete; toward Apple
  the EventKit create first, then the queued delete). The editors carry
  the fields across (core `editor/convert.ts`) and ask only when a set
  field has no home on the other side (`convertLoss.ts`;
  `previewEventToTask` computes the event side from the stored record and
  carries the series' rule, since an occurrence row never has its
  master's lines).
- **Task creates are not idempotent**: Google assigns task ids
  server-side, so a `createTask` writes a temp `local-…` row that is
  swapped for the server task on success (`rewriteEventId` renames the
  queued op; the row is remove+upsert, never an id UPDATE — a concurrent
  pull may already have inserted the server row). Before retrying a
  `createTask` that was already dispatched, the drain first lists recent
  tasks and adopts an exact match — otherwise a crash between insert and
  ack would duplicate the task. Task ops still carrying a temp id wait in
  `applyOp` until the create swaps it.
- **Moves keep queue order**: `listDue` skips ops in backoff, so a move
  and the edits of its series (`<masterId>` and `<masterId>_<basetime>`
  instance ids, any calendar of the account) check `earlierInSeries`
  first — a move waits for older edits, an edit waits for an older move,
  and occurrence edits and RSVPs wait for a create queued ahead in their
  series. `moveEvent` re-queues pending edits of the series _behind_ the
  move, re-keyed to the destination (a never-sent create simply becomes a
  create there; a sent one stays in the source with the move behind it).
  A dropped move (403 non-organizer) re-keys the rows back. Ties on
  `created_at` break by `rowid`.
- The drain loop re-reads each op by id before dispatching: a missing row
  means the user discarded it (skip), and coalescing rewrites stay
  visible. Each failure is recorded in `last_error`; the unsynced-changes
  list shows it as the row's reason.
- **An op remembers what it replaced**: `beforePayload` (the event row
  before the local write; `null` when there was none — an occurrence edit
  or delete that materialized its override), `beforeOverrides` (a series
  delete's exception rows, which queue no op of their own), `beforeTask`
  and `beforeColorHex`. When a newer edit replaces a queued op it inherits
  that op's snapshot, so the snapshot always names the last state Google
  acknowledged, however many edits piled up offline; a move re-keys it to
  the destination with the op. The unsynced-changes list diffs an op
  against it (`pendingOpDiff`, computed in `listPendingOps` as display
  lines) and an abandoned op puts it back (`releaseRow`): a discard, a
  permanent rejection and keep-mine with nothing left all restore the row
  — an op puts back only the fields it owns (an RSVP the answers it
  changed; an edit the fields it changed, the guest list only when it
  edited it, and each guest's answer stays the row's), so it cannot
  resurrect what another op of the event changed and was discarded
  meanwhile, keeping the row's own etag; a delete re-inserts the row
  unless a synced one sits there already (a pull put Google's copy back)
  and the exceptions a series delete took with it (checked one by one); a
  task edit or toggle restores the fields it owns; a color goes back only
  while the calendar still shows the op's own (calendar-list pulls do not
  skip a queued color) — and the row stays `pending` while another op of
  the item, or a queued move of it, still owns it. A row a pull deleted
  meanwhile is not resurrected, and a pull that confirms an item deleted
  upstream (a cancelled occurrence included) clears the queued delete's
  snapshot (`forgetDeleted`): the sync token has seen the deletion and
  will never send it again. When an op lands while others of the item are
  queued, every queued snapshot of the item moves to what Google
  acknowledged (`advanceBefore`, `advanceBeforeTask`; the ones queued
  earlier never held the landed change either), so discarding one of
  them never undoes it (a landed series edit moves its exceptions' queued
  snapshots to the carried text as well); a discarded op takes its owned
  fields out of the other queued snapshots and out of what they send (an
  RSVP rides in a guest-list edit's attendees, and the other way round);
  an op replaced while its request was in flight puts nothing back when
  that request is refused — the replacement owns the row. Known gap: a
  full re-list after an expired sync token confirms a deletion only by
  absence, which clears no snapshot. A snapshot
  built while other ops of the item are replaced, or under a queued
  series edit, is assembled from theirs (a series delete takes each
  exception's acknowledged state, an occurrence edit or delete the
  exception's own text under a queued series rename — `withOwnText` —
  and a series delete leaves out an exception this device only
  materialized; a task delete takes each queued op's fields), never from
  the optimistic rows. Two exceptions keep today's content: a 2xx whose body did
  not decode (the write landed) and an op queued before the snapshot
  existed, which can only be marked synced.

## Sync engine (packages/sync/src/engine.ts)

- Poll every 90 s (`SyncInterval`, a `Context.Reference`) plus kicks on
  wake/unlock/window-focus (desktop `powerMonitor`) and `AppState` active
  (iOS), throttled to one per 15 s (`syncKicker.ts`).
- `syncAll` is semaphore-serialized and always **pushes pending ops before
  pulling** — that ordering is what protects optimistic local writes from
  being overwritten by a pull (ops in backoff are the one exception; the
  `calendarColor` apply upserts the patch response to self-heal that case).
- Events sync the **whole history**: a full pass (first sync of a
  calendar, or a 410 resync) lists the calendar with no `timeMin`, and the
  sync token it returns then covers every event ever. A token is bound to
  the query it was issued for — a windowed one could never be widened, so
  a token must always come from an unbounded list. Nothing prunes by age;
  `deleteStale` only removes rows a completed full pass did not touch. The
  pass writes its `sync_state` row `'syncing'` until the list completes
  (`'error'` on failure, token kept for a failed incremental pass), and
  `listSyncStatus` turns that plus a row count into the Settings
  "Importing history…" line.
- A full list of a big calendar is many 2,500-event pages: each page is
  one transaction (`EventRepo.applyPage`) with one invalidation, and the
  engine yields between pages so rpc handlers and the UI interleave. An
  empty pull page invalidates nothing. Calendars that vanish upstream
  take their event rows and their events sync state with them in one
  transaction (`CalendarRepo.purge`), and a calendar new to the local
  list has any leftover scope cleared before its first pass — so a
  calendar that comes back always re-lists its history. A 404 from one
  calendar's `events.list` skips that calendar for the pass and drops the
  calendarList token so the next pass lists calendars in full (a 404 is
  no proof of deletion); a 404 from one list's `tasks.list` skips that
  list the same way.
- With every master ever synced in the table, `getWindow` bounds the
  recurring-masters query by a stored `recurrence_end_utc` (a plain UNTIL,
  or the last occurrence — COUNT and RDATE values included — computed
  once at write time; NULL = endless) over a partial index, so ended
  series are never expanded again. Expansion runs under an iteration cap
  and `assembleWindow` skips a master whose rule throws instead of
  blanking the window.
- Incremental pulls use syncTokens; a 410 forces a full resync, after which
  `deleteStale` purges rows the server no longer returns (pending rows are
  protected by sync_status). Local writes mark their row `pending`; pulls
  write in `mode: 'pull'`, which skips pending rows, so a queued edit is
  never clobbered by a page carrying the server's older copy. The push
  response (ack upsert), an abandoned op (`releaseRow`: the op's snapshot
  of the row goes back, or `markSynced` when it has none) or a resolved
  conflict hands the row back. Task rows work the same way
  (`setStatus`/`updateLocal` mark pending; `upsertTasks(…, { mode:
  'pull' })`).
- Cancelled events arrive as tombstones and are kept as `status:
  'cancelled'` rows when they shadow recurring instances. A pulled event
  without a zone takes its calendar's; zones are spelled for the engine
  where events come in and where rows are read (`engineZoneId`,
  `engineRecurrenceLines`: Hermes and V8 accept different IANA spellings).
- **Tasks** (per account, when the `tasks` scope is granted): task lists
  always sync as a full pass (they are few); tasks pull incrementally via
  an `updatedMin` watermark stored in `sync_state` — advanced to "now
  minus 60s" (clock-skew lag) and queried with
  `showCompleted/showHidden/showDeleted` so completions and deletions
  arrive as tombstones. A daily full pass runs `deleteStale` (only rows
  with `sync_status='synced'`). A 403 with the insufficient-scope reason
  flips `tasksEnabled` off instead of retrying forever (older grants
  without the Tasks scope).
- **Google contacts** (per account, when both People API contacts scopes
  are granted — `contactsEnabled`): two tiers, saved contacts
  (`people.connections.list`) and "other contacts" (`otherContacts.list`,
  people you've emailed), each on its own sync token in `sync_state`
  (`contacts:connections`, `contacts:other`) and its own `is_other` rows
  in the `contacts` table (one row per person × email). Incremental passes
  apply upserts and tombstones page by page; a full pass (first run, or an
  expired token) collects everything and `ContactRepo.replaceTier` swaps
  the tier in one transaction. An insufficient-scope 403 flips
  `contactsEnabled` off, like tasks. Device contacts never enter SQLite:
  `DeviceContacts` holds the bridge snapshot in memory, refreshed on
  change notifications, when stale, and after `connectContacts`. The
  `searchContacts` rpc asks `ContactRepo.search` for coarse candidates,
  adds the device list, and `rankContacts` (core) produces one deduped,
  ranked list for the combobox; the UI holds a bounded LRU of query atoms
  on `CONTACTS_KEY`. The connections tier also asks for `birthdays` and
  writes `contact_birthdays` (one row per contact, no email needed) under
  `BIRTHDAYS_KEY`; Google's read-only Birthdays calendar is skipped by
  `syncCalendarList` so a birthday never renders twice.
- **Apple Reminders** (the synthetic `apple-reminders` account, created by
  the `connectReminders` rpc after the EventKit prompt): SQLite holds the
  latest **complete** EventKit snapshot — open and completed, dated and
  undated, so paging any distance ahead or back reads locally, like
  Google Tasks. Where a task is drawn is one rule, `taskCalendarDate`
  (core `taskTiming.ts`): an open task on its due day, or on today once
  that day has passed or when it has none; a completed one on its due
  day, or on the day it was completed when it has no due day or was
  completed late. `getTasksInRange` returns the due-day window plus the
  open undated tasks and the completions around it; `getOverdueTasks`
  returns the open tasks whose day has passed, and
  `partitionCalendarTasks` (core) merges the two without duplicates.
  `syncReminders` checks authorization first — no access flags the
  account, access regained heals it without reconnecting; an
  _unavailable_ bridge is skipped, not mistaken for a revoked grant. The
  bridge's `reminders.snapshot({ changedSince })` returns every
  reminder's (list, id) plus full rows only for what changed since the
  last pass (stamp in `sync_state` scope `reminders`), and
  `TaskRepo.replaceMirror` reconciles in one transaction: ids staged in a
  temp table row by row (iOS's SQLite may cap bound variables at 999),
  changed rows upserted only when strictly newer than what is stored (a
  write-through that landed after the fetch wins), rows absent from the
  snapshot removed only when older than the pass stamp (a row a
  concurrent mutation just mirrored survives). `EKEventStoreChanged`
  (helper event line / Expo module event) runs a debounced (1 s)
  reminders-only pass under the same gate — latency only; the 90 s pass
  is the correctness mechanism, because the notification reaches a live
  observer only.
  - **Writes are EventKit-first and EventKit is the truth.** Once the
    store has committed, a failing SQLite mirror write is logged, not
    raised: the editor would otherwise show an error for a reminder that
    exists and a retried Save would create it twice; our own write fires
    `EKEventStoreChanged`, so the delta pass restores the row anyway.
  - **Save sends only what changed** (`taskEditorChanges`, both
    providers): the diff is against the values the form opened with, so
    an edit made in Reminders.app while the form was open is never
    overwritten by a stale unchanged field. An empty diff closes without
    a write.
  - **Read-only lists** (`EKCalendar.allowsContentModifications` false →
    `TaskListInfo.readOnly`) are never a create/move target and open as a
    viewer. EventKit stays the enforcement — no mutation-layer error.
  - **Wire dates are Gregorian** whatever the device calendar: the bridge
    stamps one explicit Gregorian calendar on written components and
    resolves read components in their own calendar before formatting.
    Every JSON number is range-checked (`boundedInt`) before a native
    conversion — `Int(someDouble)` traps outside Int's range.
- **Account removal vs. an in-flight pass** (both providers): every mirror
  INSERT (calendars, events, task lists, tasks, contacts, birthdays,
  sync_state) is guarded on the account row (`accountGuard`), so a pass
  that finishes after `accountRepo.remove` writes nothing; `replaceMirror`
  reports `skipped` and the engine ends the pass without stamping
  sync_state; removal itself is one transaction. Removing a Google account
  asks first, naming its unsynced changes; an Apple account only
  disconnects.

## Apple Calendar (EventKit events)

- **One synthetic account** `apple-calendar` (`provider: 'apple'`, next
  to `apple-reminders`; tell them apart with `isAppleCalendarAccount` /
  `isAppleRemindersAccount`). `connectAppleCalendar` asks for events
  access — a separate TCC grant from Reminders — and creates it.
- **Calendars are mirrored** (`syncAppleCalendar`): every EventKit
  source (iCloud, Exchange, On My Mac, subscribed) except the Birthdays
  calendar (the birthday lane shows those) and any source titled like a
  connected Google account's email (that account added to Calendar.app
  would show twice). `allowsContentModifications` → `accessRole`
  owner/reader, `defaultCalendarForNewEvents` → `isPrimary`, the source
  title → `CalendarInfo.sourceTitle` (sidebar grouping). `provider` is
  never stored: CalendarRepo joins it from the account. Unavailable
  bridge = skip; lost access = `reauth_required`, healed by the next pass.
- **Events are read through, never stored.** EventKit is already a local
  database and expands series itself; a mirror would need a window and
  could disagree with Calendar.app. `AppleCalendarEvents.eventsInRange`
  asks the bridge for exactly the range a view shows (the bridge chunks
  EventKit's four-year predicate limit) and keeps visible mirrored
  calendars only. There is no range cache: EventKit is local and fast,
  and a cache invites a read from before a write overwriting it.
  `EKEventStoreChanged` (debounced 1 s), every Apple write and
  `setCalendarVisible` invalidate `EVENTS_KEY`. The backend rpc stays the
  single query surface (views, find-a-time, search, agents).
- **Ids**: a single event is its `eventIdentifier`; an occurrence of a
  series is `<eventIdentifier>__<occurrenceSlot>` with
  `recurringEventId`/`originalStartUtc` set — the same shape
  `assembleWindow` gives Google occurrences, stable when one occurrence
  is moved on its own (the slot names the occurrence, not its start).
- **Scopes → EKSpan**: instance = `thisEvent` on the occurrence;
  following = `futureEvents` on the occurrence (EventKit splits the
  series); series = `futureEvents` on the first occurrence, a time edit
  shifting it by the edited occurrence's wall-clock delta, as for Google.
- **Recurrence** crosses as structured rules (core `StructuredRule`);
  `toStructuredRules`/`toRRuleLines` convert. EXDATE/RDATE/EXRULE,
  BYHOUR/BYMINUTE/BYSECOND, WKST≠MO and COUNT+UNTIL cannot be stored:
  a create is refused (`UnsupportedForProviderError`), a move drops them
  after confirmation.
- **Capabilities**: EventKit cannot write guests or RSVPs — the editor
  hides both for Apple events (existing guests show read-only), and the
  mutation layer rejects them. A `reader` calendar opens as a viewer, on
  either provider (`writable` guard, `CalendarNotWritableError`; both
  apps also refuse to start a drag there).
- **Moving between calendars** (`moveEvent`, always the whole series):
  Google → same Google account = queued `events.move` (keeps everything;
  organizer only); Apple → Apple = `event.calendar = target` saved with
  the series span; everything else = create in the target, then delete
  the source (a failure between leaves a duplicate, never a loss). Copies
  never carry guests; a Google conference link becomes the Apple event's
  URL, an Apple URL is appended to the Google description; modified
  occurrences are dropped. The editor asks `previewMove` first and
  confirms `moveLossSummary` when anything is dropped, then saves field
  edits at the source and moves. Converting an event into a task reuses
  the same source loading and series delete (`loadSource`, `deleteFrom`).

## Calendar mirrors (packages/sync/src/mirrors.ts, core mirror/)

A mirror copies several sources (Google and Apple calendars, Google task
lists, Reminders lists) one way into one destination calendar, reduced to
an allow-list of fields (presets Availability, Title and location, Full
details, or Custom), so a calendar can be shared without the details.

- **A run is a reconcile, not a sync.** What should exist is computed from
  the sources (`loadMirrorItems` → `buildMirrorCopies`), what exists is
  read from the destination by its markers, and `planMirror` writes the
  difference. Nothing remembers which copy belongs to which source: the
  destination is the state. So any device can run a mirror, a run cut off
  by the OS simply runs again, and two devices running the same mirror
  agree — provided their inputs agree, which is why sources are read with
  their own queries (local show/hide is ignored), "today" and the window
  are computed in the mirror's own `timeZone`, and source keys are
  portable (Google ids; EventKit's external identifier, since
  `eventIdentifier` differs per device).
- **Identity and markers.** `keyHash = sha256(mirrorId | sourceKey)`.
  Google: the event id is `slnvmr` + keyHash (a racing second insert gets
  409 and becomes a confirming replace), and the private property
  `solunivo.mirror` holds `tag.rev.contentHash`. Apple: the URL field holds
  `x-solunivo-mirror:keyHash.tag.rev.contentHash`. A Google row is a copy
  only when id and property agree, so an event someone duplicated from a
  copy is theirs. `rev` is the definition's `updatedAt`; a device whose
  definition is older than a copy's rev pauses ("changed on another
  device"); after a definition change at least one copy is restamped so
  the other device notices. Everything in a marker is opaque: the
  destination is shared with others who can read both carriers.
- **Writes.** Google copies go through `replaceEvent` (PUT: a switched-off
  field must leave the copy; PATCH keeps omitted fields), paced, in chunks
  acked through `applyPage(mode: 'ack')` under the engine's gate
  (`SyncEngine.exclusive`) so a pull cannot interleave. Apple copies go
  through `calendar.applyBatch`, one commit per batch. No guests, no
  reminders (`useDefault: false`, none), the mirror's zone, never the
  source's. Availability merges overlapping events into one block
  (`mergeBusy`, core `scheduling/`); private events copy as the busy label.
- **When a device runs a mirror** (`mirrorResolve.ts`): every source and
  the destination resolve to exactly one row here and their accounts are
  ok; every Google calendar and list involved was pulled successfully
  within five minutes (`sync_state`); no pending op targets a source; no
  other mirror's copies are in the destination; an Apple destination is
  iCloud, CalDAV or local (Exchange drops the URL). Otherwise the status
  says why, in words (`describeMirrorStatus`).
- **Backstops** for what cannot be checked (EventKit never says whether
  iCloud has caught up): a plan that would delete more than
  max(10, 30 %) of the copies with an unchanged definition waits ten
  minutes (or "Run now"); the same create or update made a third time
  within a day pauses the mirror on this device until it is switched on
  again. Deletes are never counted: when a definition change empties the
  destination, nothing carries the new revision, and a device still on
  the old definition writes the excluded copies back until its own
  creates trip its breaker — the device that is right keeps deleting and
  must not pause with it. A Google insert that meets its id (409) reads
  the event first and stands back from a newer revision.
- **Triggers.** A change to events, tasks, calendars, accounts or the
  definitions marks the inputs dirty; a finished sync pass runs the
  mirrors (cheap gates first, the heavy part only when dirty); a heartbeat
  follows midnight in each mirror's zone (undated and overdue tasks move
  to today). iOS runs a budgeted pass at the end of the background task;
  a first fill is foreground work.
- **Storage.** Definitions in `device_settings` `mirrors` (portable: the
  `mirrors` section of the settings document, import adds or updates,
  never removes, and an imported mirror arrives switched off); on/off,
  status, the newest revision seen and the rewrite journal in
  `mirrors.local`, this device's own. Copies are hidden in
  `EventRepo.getWindow` and the Apple read-through: the originals are
  already drawn. The editor can create the destination (Google under the
  `calendar.app.created` scope, Apple in the default account).
- **Tasks** become events by `taskCalendarDate` (above); a completed
  task's copy gets a "✓ " prefix.

## Search (core `search/`, packages/sync/src/search.ts)

- **One rpc**, `search({ query, timeZone })`, handled by `searchCalendar`
  for both apps, "now" from Effect's Clock. It reads what the views can
  show over `SEARCH_WINDOW_YEARS` (two) either side of today in the
  primary zone: the stored rows the range query reads (`EventRepo.getWindow`:
  visible calendars, no mirror copies, no cancelled rows), the Apple
  events EventKit answers for the window, and every task of the visible
  lists (`TaskRepo.getVisible`). Events outside the window are not found;
  full-text search over the stored rows is the way past it (todo.md).
- **A matching series is not expanded over the window** — an hourly one's
  thousands of occurrences would pass the expander's iteration cap.
  `seriesSearchOccurrences` walks it outward from now instead, forward
  and then back only when nothing is left ahead, to its next occurrence
  that is not over, else its latest one. The slots its overrides took
  over are left out of the walk: an override is a row of its own, matched
  on its own text.
- **Matching is TypeScript, not SQL** (`searchTerms`,
  `eventMatchesSearch`, `taskMatchesSearch`): NFD with the combining marks
  dropped, lowercased without a locale; every word of the query must occur
  in one field — an event's title, place, notes, guest names and
  addresses, a task's title and notes. SQLite's LIKE folds neither accents
  nor non-ASCII case.
- **Results** (`buildSearchResults`): one hit per series, keyed by account,
  calendar and `recurringEventId`, at its next matching occurrence that is
  not over, else its latest past one. Upcoming soonest first, past most
  recent first, tasks open by due day, then undated, then completed latest
  first; 50 per group, each with its total. All-day events are judged by
  their dates in the zone, not by their UTC midnights.
- **UI**: `useSearch` (app-state) debounces 200 ms and keeps one atom per
  query in the bounded LRU, so a late answer for an earlier query never
  shows; the previous results stay up while the next load (`stale`), and
  the atoms re-run on EVENTS_KEY and TASKS_KEY. The agent gateway has no
  search tool yet.

## Recurring events

- Masters carry `recurrence` (raw RFC 5545 lines, no DTSTART — derived from
  the event start in `packages/core/src/recurrence/expand.ts` via
  rrule-temporal; every `RRuleTemporal` is given the app's `Temporal`
  namespace through its `temporal` option, so occurrences are
  `@js-temporal/polyfill` instances on both platforms).
- DTSTART is always the first occurrence, as on Google, even on a day the
  rule skips (and never counted in COUNT): `buildRuleString` lists it as
  an RDATE as well, which rrule-temporal otherwise drops. A set of only
  RDATE lines has no rule: `buildRuleString` gives it
  `RRULE:FREQ=DAILY;COUNT=1`, so it expands as DTSTART + RDATE − EXDATE
  through the same library pass as every rule.
- The UI never sees masters directly: `assembleWindow` expands them into
  synthetic instances with id `<masterId>__<originalStartUtc>` carrying
  `recurringEventId` + `originalStartUtc`.
- Editing scopes (`packages/core/src/recurrence/editing.ts` + mutations):
  - **instance** — materialize an exception row under Google's canonical
    instance id `<masterId>_<YYYYMMDDTHHMMSSZ>` (`<YYYYMMDD>` all-day);
    deletes write `cancelled` tombstones. Using Google's own id makes the
    later sync upsert idempotent.
  - **series** — patch the master; time edits apply the occurrence's
    wall-clock delta (`applyWallClockDelta` in `time/dragMath.ts`,
    DST-safe). A new rule (`changes.recurrence`, RFC 5545 lines) replaces
    the master's and drops its exceptions — they belonged to occurrences
    of the old rule, which is what Google does with them; `null` ("does
    not repeat") leaves the master as a single event at its own start.
    Google keeps a rule whose key is absent from a PATCH, so the op
    carries `recurrenceCleared` and the patch sends `recurrence: []`. A
    master's changed title, description or location is mirrored onto the
    local override rows as a projection of the queued op (`carriedText`),
    since Google copies it onto every exception.
  - **following** — truncate the old master's RRULE with `UNTIL = split−1s`
    (COUNT dropped, RDATE values at or after the split pruned), spawn a
    new master (COUNT recomputed from the RRULE line alone,
    `ruleOccurrencesBefore`; or the edit's own rule; `null` makes the
    occurrence a single event), cancel later overrides.
  - An instance never carries a rule and a single event does not become a
    series through an update (`RecurringEditUnsupportedError`). The
    all-day switch on an existing series is refused
    (`RecurringAllDaySwitchError`) and an all-day series moves one
    occurrence at a time (`RecurringAllDayMoveError`).
- The editor reads a series' master with `getEvent` (`useEventMaster`) to
  seed its repeat fields — an occurrence row has no lines — and sends the
  rule only when those fields were edited. A read-through Apple series
  has no stored master, so its rule stays uneditable in the app.
- Dragging a recurring instance commits an instance-scope override.

## Time-grid gestures

- **Move and resize an event**: desktop `useEventDrag` (pointer capture,
  4 px threshold, 15-minute snap, days by column width; Enter/Space are
  ignored mid-press and a lost capture ends the drag); iOS
  `DraggableEventBlock` (250 ms long press, then drag; a bottom handle
  resizes with the same hold). Both commit through the op queue. The
  desktop hook is owned by the app, not the week view, so the panel's
  task rows drag onto the grid and lane too; a task drop is judged by
  where the pointer is released (`dropTargetAt`) under one pure rule
  (`dropTaskChanges`: a grid drop sets day and time, a lane drop clears
  the time, a Google task dropped into the grid is `unsupported` and
  snaps back).
- **Draw a new event's slot**: desktop `useSlotDrag` — press on empty
  grid space and drag, release opens the editor with that slot; only
  vertical travel counts toward the threshold, so a click that drifts
  sideways stays the hour click. iOS `DayColumn` — hold 300 ms on empty
  space (a one-hour slot appears from the quarter the finger touched down
  in), drag while holding to grow it, release opens the sheet with exactly
  the slot shown; the hold slot only grows, so finger drift never shifts
  it. The math is shared (`packages/core/src/time/slotSelection.ts`,
  worklets so iOS runs them on the UI thread), and the editors take it as
  `EventEditorSeed.initialTimes`.
- **A gesture that starts on an event never draws a slot**: desktop blocks
  stop propagation in their pointerdown; iOS blocks are drawn above the
  column's gesture layer. Each hook suppresses the click its own release
  would otherwise turn into an hour click.
- **Paging**: the desktop trackpad pans day columns 1:1 inside a clipped
  strip (`core/gestures/wheelPan.ts`, `--pan-x` written imperatively) and
  eases to the nearest day when the wheel goes quiet; iOS swipes page day
  by day over a drawn buffer per view (`core/layout/dayStrip.ts`), the
  UI thread handing React the pixels navigated so the page change and the
  strip move land in one mount.

## Agent gateway (desktop)

Other agents on the Mac get in through one more door, not through the rpc
seam: a Unix socket in the main process (`apps/desktop/electron/agent/`)
that authenticates a per-agent token and then serves MCP or one CLI
command, both over the same tool set. Every call goes through `callTool`
(`packages/agent/src/gateway.ts`) on the backend runtime — the same
services the renderer's rpc handlers use, with the agent store's services
(a second, tiny runtime over `agents.db`) provided into each effect. The
backend itself has no caller identity or permission checks, so the
gateway carries all of it. Details, limits and the threat model:
`docs/agent-gateway.md`.

## Platform seams

- **rpc vs IPC.** Calendar data crosses process boundaries **only**
  through the typed rpc seam (Apple events, reminders and contact rows
  included). Window-level concerns use plain preload IPC
  (`apps/desktop/electron/preload.ts`): `renderer-error` (→
  `userData/logs/main.log`, 1 MB rotation), `privacy:*` (screen-capture
  protection, default hidden, stored in `userData/settings.json`), the
  `model:*` channels, the `reminders:status` / `contacts:status` /
  `appleCalendar:status` permission asks, `settings:open`,
  `settingsFile:*`, `auth:cancel`, `notifications:take`, `rpc:document`
  (a reload re-registers the page as an rpc client) and `agents:*`
  (device-local, never rpc, never exported). The window-open handler sends
  Join-meeting links to the system browser.
- **Main process.** Single-instance per profile
  (`requestSingleInstanceLock`, taken after the `CALENDAR_USERDATA`
  override); keeps running without a window on macOS, and `windows.ts`
  opens one on demand (Dock, a notification click, a second launch).
  `--background` starts without a window — what the agent relay passes
  when it has to launch the app. A content-security policy is applied
  outside dev and reaches the packaged `file://` page; `will-navigate` and
  `setWindowOpenHandler` allow-lists cover every web contents.
- **Two windows, one renderer bundle.** `renderer/main.tsx` mounts the
  calendar, or the settings window when the page was loaded at `#settings`
  (`showSettingsWindow`: one at most, fixed 780×560, not minimizable or
  maximizable). Settings opens from the application menu (`menu.ts`:
  Settings…, ⌘,) — also with no main window — or over `settings:open`. It
  is a sidebar of panes (General, Accounts, Notifications, Advanced, then
  Mirrors and Agents under an "Experimental" heading) with a search field
  (`filterPanes`). The pane is the URL hash (`#settings/<pane>`): the main
  process moves an open window by navigating the hash, the page only ever
  reads it. Each window is its own rpc client with its own atoms, kept in
  step by the invalidation stream; `privacy:changed`, `agents:changed` and
  `settingsFile:changed` go to every window. The agent approval dialog,
  the conflict banner and the dropped-change toast live in the main
  window only. Find the main window through `showMainWindow` /
  `hasMainWindow`, never `getAllWindows()[0]`.
- **Theme.** `brand/tokens/tokens.json` is the one source. `pnpm
  brand:build` writes `brand/tokens/tokens.css` (`:root` and
  `[data-theme='dark']`) and `packages/core/src/theme/tokens.ts`
  (`THEMES.light/dark`), both guarded by `brand:check`. The desktop
  imports the CSS; `App.css` maps every variable into Tailwind's theme
  (`bg-canvas`, `bg-fill`, `text-ink`, `border-hairline`, `bg-primary`, …
  — the renderer's only colors; `themeClasses.test.ts` fails on Tailwind's
  own palette) and `renderer/theme.ts` mirrors `prefers-color-scheme` onto
  `data-theme` before the first paint. iOS reads the TS module through
  `useTheme()`. Calendar colors are arbitrary hex, so every
  calendar-colored block or chip goes through `eventTint(hex, scheme)`:
  hue and chroma from the calendar, lightness from the theme, text on
  fill at 4.5:1; the brand `event-*` tokens are for items with no
  calendar. A box that asks or warns uses `CALLOUT_CLASS`.
- **Desktop shell** (`renderer/calendar/`): a toolbar (`Toolbar.tsx`:
  sidebar toggle, title, ‹ Today ›, Day/Week/Month, Search, the Today
  panel toggle, New), a collapsible sidebar (mini month, calendars and
  lists per account, the sync footer with the unsynced changes), the
  grid, and a side panel (`panel/`) that is one `PanelState` in
  `CalendarApp.tsx`: the Today rail at rest (`UpNextCard` + `TaskInbox`),
  search (⌘F), an event's read-first inspector after a grid click or a
  search result (`EventInspector.tsx`), or the inline editor
  (`EditorPanel.tsx`, 360 px) from Edit, a slot, New (⌘N; ⌘K goes
  straight into its quick-add field), a task chip or a result. Single
  keys: T = today, ←/→ step the view; ⌘, opens Settings from the menu. A new
  item's editor is the one add path: the quick-add field on top
  (`QuickAddBar`, a phrase or a dictation fills the form; Find time lists
  free slots), the Event | Task | Reminder control (`useEditorKinds`, only
  the kinds something can hold), then the form; on an existing item the
  control converts. The panel never joins the dialog stack
  (`dialogStack.ts`: the topmost dialog alone answers Escape and traps
  Tab), so a real dialog over it keeps Escape; a panel opened from a
  search result closes back to the results. The inspector follows its
  event by identity (core `eventIdentity`), reads from the grid's current
  row (or `findCurrentEvent`), and closes when the event is gone; an
  editor keeps its seed. Notices (`NoticeStack`: failed write, discarded
  change, conflict banner) stack in one column inside the grid's area.
  Every editor write runs through one slot (`useOneWrite`); deletes ask
  first. `lastView` and `sidebarCollapsed` are device taste in the view
  preferences, read before the first paint.
- **iOS shell** (`apps/ios/app/`, expo-router): `_layout.tsx` mounts the
  providers, the editor host and a native stack with the tab bar
  (`(tabs)/`: Calendar · Tasks · Search, the last a stack of one screen
  whose `Stack.SearchBar` is the system search field) and Settings as a
  modal route holding its own native stack (`settings/`: the root list, a
  page per pane; rows drawn by `src/ui/settings/GroupedList.tsx`,
  switches through `@expo/ui`). `src/ui/CalendarScreen.tsx` is the
  calendar tab: a header (title, the view menu Day · 2 Days · Week ·
  Month · Agenda, ‹ Today ›, the account avatar into Settings carrying the
  unsynced badge), the week strip, the timeline / month grid / agenda,
  and the "+" (`AddButton`, shared with the Tasks tab: the calendar's
  opens a new event, the Tasks tab's an undated to-do in the filtered
  list). `EditorHost.tsx` owns every sheet — event detail, the editor
  (`EventEditSheet`, the same add path as the desktop), the birthday
  detail, the capture review — and the capture model behind the share
  sheet and deep links; screens ask it through `useEditorHost()`.
  `+native-intent.tsx` keeps non-route URLs on the calendar. Sheets are
  React Native page sheets; `@expo/ui` is used where it is a drop-in.
  Text that cannot grow (grid blocks, chips, the gutter, bars) is capped
  at `BOX_FONT_SCALE` for Dynamic Type; the rest scales fully.
- **Views**: day/week time grid (with "2 Days" and a two-week agenda on
  iOS), month grid, and an all-day lane for date-only tasks that
  collapses to three rows with "+N more" (a device setting). Timed Apple
  Reminders share the day-column overlap layout with events as compact,
  move-only blocks; their due time is wall-clock data, and the day column
  is a fixed 24-hour wall clock (`layoutDayColumn` places every box by
  wall-clock minute, so DST days draw as Google Calendar does). Task
  checkboxes are drawn (`TaskCheck`), never glyphs. Month cells show
  tasks and birthdays after the day's events as read-only summaries
  (events keep the cap — they carry the calendar's color), announce their
  counts through `monthCellLabel`, and open the day; both kinds are
  bucketed with `groupByDate`.
- **Birthdays** are a third all-day kind, not events: `getBirthdaysInRange`
  merges the Google People cache and the device snapshot
  (`DeviceContacts.birthdays()`) by folded name + MM-DD
  (`mergeBirthdays`, `birthdayMergeKey`), expands occurrences per day
  (Feb 29 lands on Feb 28 in common years), and both lanes draw a neutral
  chip with a fixed pink accent (`birthdayChipLabel`). The detail view
  lists every source; the birthday itself is read-only, and the one thing
  it edits is that person's reminder lead days.
- **Locations and maps**: Google stores only location text, so
  coordinates (`EventRecord.geo`: lat, lng, name, and `source`, the text
  they came from) are derived on-device through `GeoClient` (MapKit) and
  are valid only while `source` matches the location (`geoMatches`;
  every local write goes through `withConsistentGeo`). They travel in the
  event's private extendedProperties, so other devices skip geocoding.
  Only coordinates the user vouched for are mirrored: the event's own or
  a picked suggestion. A local edit that drops them flags its queued
  update `geoCleared`, and only that PATCH deletes the keys with nulls.
  Events without mirrored coordinates are geocoded when the editor opens
  (`resolveLocation`, cached in the device-local `location_geo` table:
  misses for 3 days, hits refreshed in the background after 14 days,
  pruned to 2000 rows, wiped from Settings) for the map on this device
  only; typing never geocodes — the typeahead (`searchPlaces`) and a
  picked row do. URLs and meeting links are never looked up. Desktop
  draws a static `MKMapSnapshotter` PNG (`mapSnapshot`); iOS a live
  `expo-maps` view (iOS 17+, else only the Open in Maps link).
- **Device settings and the settings document**: `device_settings` is a
  key/value table for preferences that never sync to Google
  (`birthdayReminders`, `birthdayReminderOverrides` — keyed through
  `birthdayMergeKey`, so an override survives a source coming or going —
  `eventNotifications`, `timeZones`, `viewPreferences`, `mirrors`,
  `mirrors.local`, `importedVisibility`, `localNotifications.*`), behind
  rpc because the consumer is a backend job in both hosts. The portable
  subset travels in `SettingsDocument` (core): Export/Import on both apps
  and the desktop's watched `~/.solunivo/solunivo.jsonc`, two-way (file →
  app through a directory watch plus a periodic stat; app → file through
  `jsonc-parser` edits so comments survive). Accounts are a sign-in
  checklist, never tokens; an import never removes anything and never
  connects an Apple provider; visibility for rows not synced yet is
  parked in `importedVisibility` and applied after each list pass.
- **Time zones**: up to three IANA zones per device, one primary, which
  replaces the device zone for everything the UI draws (both roots gate
  on `useTimeZones()`); the others annotate the hour gutter and tall
  blocks. The catalog is a checked-in canonical list; a device stores the
  spelling its engine validates (`runtimeZoneId`) and displays through
  `canonicalZoneId`. Notifications, EventKit's floating zone and timed
  reminders stay on the device zone, read on every pass.
- **Local notifications**: `LocalNotifications` (packages/sync) runs its
  own loop — outside the sync pass — over two producers, `loadEventPlans`
  (visible calendars, a week ahead, `useDefault` resolved against the
  calendar's `defaultReminders`, Apple Calendar events only when the
  setting includes them) and `loadBirthdayPlans` (a person's own lead
  days replace the general ones; the general switch gates both), merged
  into one `PlannedNotification` list, each carrying a `target` the tap
  resolves (`findNotificationEvent`). A producer whose setting is off
  returns nothing; the OS schedule is cleared only when both do. The
  platform `NotificationSink` delivers: desktop fires an Electron
  `Notification` when one is due and, after sleep, only while the plan's
  `expiresAt` allows (fired keys kept in `device_settings`); iOS replaces
  the pending expo-notifications schedule with the soonest ≤ 60 whenever
  the digest changes. The loop sleeps until the next delivery (5 s..60 s)
  and re-plans, debounced, on `EVENTS_KEY` / `BIRTHDAYS_KEY`; a settings
  write is not one of those, so each settings path runs a pass itself.
  On iOS a background task (`apps/ios/src/backgroundTask.ts`,
  `expo-background-task`, 30-minute minimum) runs `backgroundRefresh`: a
  pull bounded to 20 s, then one notification pass and a budgeted mirror
  pass; Google tokens are stored `AFTER_FIRST_UNLOCK` so that pull can run
  while the phone is locked (`apps/ios/src/tokenStore.ts`; a key change
  writes the new item before deleting the old — the refresh token is the
  only copy). The OS grants the `BGProcessingTask` when it likes; to
  exercise it, call `triggerBackgroundRefreshForTesting` in a debug build
  or the debugger's `_simulateLaunchForTaskWithIdentifier:` on
  `com.expo.modules.backgroundtask.processing`.
- **Event reminders** are data on the record (`EventRecord.reminders`,
  Google's `useDefault`/`overrides` shape; `useDefault:false` with no
  overrides is "none", distinct from the field being absent), mirrored
  from Google and from EventKit alarms (`useDefault` always false). A
  PATCH carries the whole object only when the op is flagged
  `remindersChanged`, since Google replaces it and email overrides must
  survive an unrelated edit.
- **The task editor** forks on the selected list's provider
  (`useTaskEditorModel.provider`): Google gets title/day/notes with a
  fixed list; Reminders get time, priority, alert, repeat (shared
  `useRepeatState`), URL, and a movable list. "Reminder" is a kind of the
  editor's control (core `editor/itemKinds.ts`), not a list choice.
- **Time is Temporal everywhere** (`@js-temporal/polyfill` via
  `packages/core/src/time/temporal.ts`); Hermes needs the
  `Intl.resolvedOptions` shim in `packages/core/src/time/intl-compat.ts`.
