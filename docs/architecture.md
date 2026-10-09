# Architecture

Client-only: both apps talk directly to the Google Calendar and Google
Tasks REST APIs, and to Apple Reminders and the Apple Calendar app's
calendars through EventKit. There is no
server of ours; all state lives in a local SQLite database per device and
reconciles against Google / EventKit.

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

AI (all on-device, no cloud): prompts, JSON schemas, normalization, and
parsing live in packages/ai behind provider seams; the pure findSlots
solver (packages/core/src/scheduling/) computes free slots from the
already-synced local events. Desktop: renderer → preload IPC
(model:status / model:generate / model:prepare-speech / model:transcribe)
→ main → Swift helper child process (apps/desktop/helper, Foundation
Models + SpeechAnalyzer over newline-JSON stdio; spawned lazily and
supervised with restart backoff by apps/desktop/electron/modelHelper.ts).
iOS reaches the same models via @react-native-ai/apple. Dictation audio
is captured by the UI layer (renderer getUserMedia → 16kHz WAV) and only
transcribed natively.

Apple Reminders: RemindersClient (packages/reminders) speaks one JSON
protocol to two native bridges built from a single Swift source —
desktop: backend (main) → helperProcess.callHelper('reminders.*') → Swift
helper → EventKit; iOS: backend → local Expo module → EventKit. Reads
are mirrored into the tasks table by the sync pass; writes go to EventKit
first and mirror the returned reminder (no pending op — EventKit is local
and synchronous). The permission ask (`reminders:*` preload IPC on
desktop, the Settings diagnostics row on iOS) is a window-level concern;
reminder rows only ever cross the rpc seam.

Apple Calendar: AppleCalendarClient (packages/apple-calendar) is the
same shape again — `calendar.*` over the helper (macOS) or the
solunivo-apple-calendar Expo module (iOS), one Swift source
(swift/AppleCalendarBridge.swift). Calendars are mirrored into the
calendars table by the sync pass; events are **read through**: the
`getEventsInRange` handler merges the Google window with a live
EventKit query for the same range (AppleCalendarEvents), so nothing is
stored and there is no window to maintain. Writes go to EventKit
directly (no pending op). The permission ask is `appleCalendar:status`
preload IPC on desktop plus the `connectAppleCalendar` rpc.

Device contacts: ContactsClient (packages/contacts) is the same shape,
read-only — `contacts.status` / `requestAccess` / `snapshot` over the
helper stdio (macOS) or the solunivo-contacts Expo module (iOS), both
built from swift/ContactsBridge.swift (CNContactStore). The backend
keeps the snapshot in memory for the invitee typeahead; nothing is
written to SQLite and nothing leaves the device.
```

Invalidation path (backend → UI): repo mutations invalidate Reactivity keys
(`accounts`, `calendars`, `events`, `pendingOps`, `tasks`, `taskLists`,
plus `notice:dropped` as a broadcast-only signal). `forwardingReactivity`
(packages/db/src/reactivityForward.ts) decorates the backend Reactivity to
also publish every key to an in-process invalidation bus
(packages/db/src/invalidationBus.ts); the bus feeds the `stream: true`
`invalidations` rpc, and `bindInvalidations` (atoms.ts) replays keys into
the UI runtime's Reactivity. Result: a change written by the sync engine in
the Electron main process repaints React in the renderer with no polling.

## Pending-op queue (offline-tolerant writes)

Every mutation writes SQLite optimistically, then enqueues a `PendingOp`
and kicks `processPendingOps` (semaphore-serialized, drains due ops
oldest-first). Kinds:

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

Rules that keep the queue correct:

- **Coalescing**: a content edit removes prior ops for the same
  (accountId, calendarId, eventId) — a shared calendar repeats its ids
  under every account — and re-enqueues (a never-sent `create` absorbs
  edits; a sent one stays ahead and the edit follows it);
  `removeForEvent` deliberately spares `rsvp` and `move` ops; `calendarColor` ops
  coalesce **per account** under the sentinel (the same shared calendar id
  can exist under several accounts).
- **Backoff**: transient failures retry at `30s·2^attempts`, capped at
  30 min (`markFailed`). Non-409 4xx (except 429) are permanent → drop. A
  sync the user caused (`SyncEngine.syncNow`: the app came back, the
  machine woke, an account reconnected) makes waiting ops due at once
  (`retryNow`); the timed poll keeps the backoff.
- **Acks** (`settle`, one transaction with the queue check, so an edit
  queued meanwhile is either seen or waits): a response is written to its
  row only while no later op of the event is queued — that op owns the
  row and its own response settles it. An `update` that lands moves the
  ops queued after it on the etag it was sent with, and the row a later
  edit still holds, to the etag it produced (`advanceBaseEtag`,
  `advanceEtag`): a second drag made while the first was in flight
  follows it instead of meeting a 412, and so does a third that replaces
  the second. Only an If-Match write does this — Google checked that
  etag, so nothing else changed in between. An `rsvp` does it when its
  If-Match held, so an edit queued right behind it follows it; one resent
  unchecked after a 412 moves nothing. An op queued _before_ the one that
  landed (in backoff while it overtook) keeps its etag: it was built
  without that change — a guest-list edit there still carries the
  response the RSVP replaced — and meets its 412. A create answered 409
  (an earlier attempt landed, its response lost) fetches what Google has,
  so the row stops being `pending`; the queue is checked again after the
  fetch. A `delete` answered 404 or 410 is done and leaves the local
  state alone: for one occurrence that state is the cancelled override
  that keeps it away. A create dropped for good takes a move queued
  behind it along, with the rows it already put at the destination.
- **412 Conflict** (only `update` and `delete` park; an `rsvp` resends unchecked): the op is
  **parked**, never dropped — unless Google's copy already yields exactly
  the PATCH body the update would send (`updateBody` built from both: our
  own earlier attempt landed), which is done. Its followers keep their
  etag there: the match covers only the fields this update sends, and
  another client may have changed the rest — each follower meets its own
  412 and its own check. The drain fetches Google's copy
  (`events.get`; 404/410 = deleted there) and `markConflict` stores it in
  `server_payload` with `conflict_at` set; a failed fetch is an ordinary
  retry. `listDue` skips parked ops and the local row stays `pending`, so
  pulls keep skipping it and the user's version stays on screen. The UI
  reads the conflict from `listPendingOps` (`PendingOpSummary.conflict`:
  mine, theirs) — a persistent banner on both apps plus the queue rows —
  and `resolveConflict` settles it: **mine** unparks with `base_etag`
  cleared so the re-send overwrites Google (a parked delete also removes a
  copy a pull re-inserted meanwhile; an edit of an event Google deleted is
  re-created under a new id as a standalone event); **theirs** re-fetches
  Google's _current_ copy (the stored one is a preview, and a pull may
  have consumed a newer change while the row was pending) and writes it in
  ack mode, then drops the op. Take-theirs is refused while a move of the
  series is queued ahead (the op already points at the destination). A
  new edit of a parked event coalesces as usual and parks again with the
  newer payload; a move re-queues a parked op still parked.
- **401**: the op stays queued, the account is flagged `reauth_required`;
  reconnecting (same account id, resolved by email) resets status and the
  queue drains at once (`syncNow`), backoff or not.
- **Provider dispatch**: `completeTask/createTask/deleteTask/updateTask`
  look up the account's provider. Google lists take the queue path
  below; Apple lists call EventKit synchronously via `reminderMutations`
  and write the result through (`upsertTasks`), so a created reminder has
  its real id from the start. Reminders-only fields (time, priority, url,
  alarms, recurrence, `moveToListId`) on a Google list fail with
  `UnsupportedForProviderError`.
- **Task moves** (`moveTask`, the task twin of `moveEvent`): between two
  Reminders lists EventKit changes the list in place; every other route —
  Reminders ↔ Google and Google → another Google list or account — creates
  the task in the target from the editor's draft and then deletes the
  source, so a failure in between leaves a duplicate, never a lost task.
  Completion follows the task. What a route drops is computed in core
  (`taskMoveLoss`) from the source record and confirmed in the editor
  before anything is written.
- **Conversions** (`convertEventToTask`, `convertTaskToEvent`): an event
  becomes a task (the whole series for a recurring one) or a task an
  event by creating the other kind from the editor's draft and then
  deleting the source — the same copy-then-delete as a cross-provider
  move, through the shared `crossStore` ordering (Google → Google in one
  transaction; toward Google the queued create first, then the EventKit
  delete; toward Apple the EventKit create first, then the queued
  delete). The editors carry the fields across (core `convert.ts`) and
  ask only when a set field has no home on the other side (core
  `convertLoss.ts`; `previewEventToTask` computes the event side from the
  stored record and carries the series' rule, since an occurrence row
  never has its master's lines).
- **Task creates are not idempotent**: Google assigns task ids
  server-side, so a `createTask` writes a temp `local-…` row that is
  swapped for the server task on success (`rewriteEventId` renames the
  queued op; the row is remove+upsert, never an id UPDATE — a concurrent
  pull may already have inserted the server row). Before retrying a
  `createTask` that was already **dispatched** (`dispatched_at` stamp),
  the drain first lists recent tasks and adopts a match — otherwise a
  crash between insert and ack would duplicate the task.
- **Moves keep queue order**: `listDue` skips ops in backoff, so a move
  and the edits of its series (`<masterId>` and `<masterId>_<basetime>`
  instance ids, any calendar of the account) check `earlierInSeries`
  first — a move waits for older edits, an edit waits for an older move.
  `moveEvent` re-queues pending edits of the series _behind_ the move,
  re-keyed to the destination (a pending create simply becomes a create
  there). A dropped move (403 non-organizer) re-keys the rows back.
  Ties on `created_at` break by `rowid` (insertion order).
- The drain loop re-reads each op by id before dispatching: a missing row
  means the user discarded it (skip), and coalescing rewrites stay
  visible.
- The op queue is surfaced in the UI (`listPendingOps`/`discardPendingOp`
  rpcs, "N unsynced changes" panel). Discarding an op hands its row back
  to sync the same way a dropped op does (`releaseRow`). `PendingOpSummary` in core/backend.ts
  has its **own kind literal** — extend it whenever a kind is added.

## Sync engine (packages/sync/src/engine.ts)

- Poll every ~90s + immediate kicks on wake/unlock/window-focus (desktop
  `powerMonitor`) and `AppState` active (iOS), debounced 15s.
- `syncAll` is semaphore-serialized and always **pushes pending ops before
  pulling** — that ordering is what protects optimistic local writes from
  being overwritten by a pull (ops in backoff are the one exception; the
  `calendarColor` apply upserts the patch response to self-heal that case).
- Events sync the **whole history**: a full pass (first sync of a
  calendar, or a 410 resync) lists the calendar with no `timeMin`, and the
  sync token it returns then covers every event ever. A token is bound to
  the query it was issued for — a windowed one could never be widened,
  so a token must always come from an unbounded list.
  Nothing prunes by age; `deleteStale` only removes rows a completed full
  pass did not touch. The pass writes its `sync_state` row `'syncing'`
  until the list completes (`'error'` on failure, token kept for a failed
  incremental pass), and `listSyncStatus` turns that plus a row count into
  the Settings "Importing history…" line.
- A full list of a big calendar is many 2,500-event pages: each page is
  one transaction (`EventRepo.applyPage`) with one invalidation, and the
  engine yields between pages so rpc handlers and the UI interleave.
  Calendars that vanish upstream take their event rows and their events
  sync state with them in one transaction (`CalendarRepo.purge`), and a
  calendar new to the local list has any leftover scope cleared before
  its first pass — so a calendar that comes back always re-lists its
  history.
- With every master ever synced in the table, `getWindow` bounds the
  recurring-masters query by a stored `recurrence_end_utc` (a plain UNTIL,
  or the last occurrence — COUNT and RDATE values included — computed
  once at write time; NULL = endless) over a partial index, so ended
  series are never expanded again. DTSTART is always the first
  occurrence, as on Google, even on a day the rule skips (and never
  counted in COUNT): `buildRuleString` lists it as an RDATE as well,
  which rrule-temporal otherwise drops. A set of only RDATE lines has no
  rule: `buildRuleString` gives it `RRULE:FREQ=DAILY;COUNT=1`, so it
  expands as DTSTART + RDATE − EXDATE through the same library pass as
  every rule. Expansion
  runs under an explicit iteration cap and `assembleWindow` skips a master
  whose rule throws instead of blanking the window (the handler logs it).
- Incremental pulls use syncTokens; a 410 forces a full resync, after which
  `deleteStale` purges rows the server no longer returns (pending rows are
  protected by sync_status). Local writes mark their row `pending`; pulls
  upsert in `mode: 'pull'`, which skips pending rows, so a queued edit is
  never clobbered by a page carrying the server's older copy. The push
  response (ack upsert), an abandoned op (`markSynced` on drop or discard)
  or a resolved conflict (take-theirs writes Google's copy) hands the row
  back. Task rows work the same way (`setStatus`/`updateLocal`
  mark pending; `upsertTasks(…, { mode: 'pull' })`).
- Cancelled events arrive as tombstones and are kept as `status:
  'cancelled'` rows when they shadow recurring instances.
- **Tasks** (per account, when the `tasks` scope is granted): task lists
  always sync as a full pass (they are few); tasks pull incrementally via
  an `updatedMin` watermark stored in `sync_state` — advanced to "now
  minus 60s" (clock-skew lag) and queried with
  `showCompleted/showHidden/showDeleted` so completions and deletions
  arrive as tombstones. A daily full pass runs `deleteStale` (only rows
  with `sync_status='synced'` — pending local writes are protected). A
  403 with the insufficient-scope reason flips `tasksEnabled` off instead
  of retrying forever (older grants without the Tasks scope).
- **Google contacts** (per account, when both People API contacts scopes
  are granted — `contactsEnabled`): two tiers, saved contacts
  (`people.connections.list`) and "other contacts" (`otherContacts.list`,
  people you've emailed — what Google Calendar's own suggestions use),
  each on its own sync token in `sync_state` (`contacts:connections`,
  `contacts:other`) and its own `is_other` rows in the `contacts` table
  (one row per person × email). Incremental passes apply upserts and
  tombstones page by page; a full pass (first run, or an expired token:
  410, or People's 400 `EXPIRED_SYNC_TOKEN`) collects everything and
  `ContactRepo.replaceTier` swaps the tier in one transaction. An
  insufficient-scope 403 flips `contactsEnabled` off, like tasks. Device
  contacts never enter SQLite: `DeviceContacts` (packages/sync) holds the
  bridge snapshot in memory, refreshed on change notifications, when
  stale, and after `connectContacts`. The `searchContacts` rpc asks
  `ContactRepo.search` for coarse candidates, adds the device list, and
  `rankContacts` (core) produces one deduped, ranked list for the
  combobox; the UI holds a bounded LRU of query atoms on `CONTACTS_KEY`.
  The connections tier also asks for `birthdays` and writes
  `contact_birthdays` (one row per contact, no email needed) under
  `BIRTHDAYS_KEY`; `otherContacts.list` cannot return the field. Google's
  read-only Birthdays calendar is skipped by `syncCalendarList` so a
  birthday never renders twice.
- **Apple Reminders** (the synthetic `apple-reminders` account, created by
  the `connectReminders` rpc after the EventKit prompt): SQLite holds the
  latest **complete** EventKit snapshot — open and completed, dated and
  undated, so paging any distance ahead or back reads locally, like
  Google Tasks. Where a task is drawn is one rule, `taskCalendarDate`
  (core `taskTiming.ts`): an open task on its due day, or on today once
  that day has passed or when it has none; a completed one on its due
  day, or on the day it was completed when it has no due day or was
  completed late. `getTasksInRange` therefore returns the due-day window
  (`getWindow`, which still excludes undated rows — agent reads use it)
  plus the open undated tasks and the completions around the window. `syncReminders` checks authorization first — no
  access flags the account, access regained heals it without
  reconnecting; an _unavailable_ bridge is skipped, not mistaken for a
  revoked grant. The bridge's `reminders.snapshot({ changedSince })`
  returns every reminder's (list, id) plus full rows only for what
  changed since the last pass (stamp in `sync_state` scope `reminders`),
  and `TaskRepo.replaceMirror` reconciles in one transaction: ids staged
  in a temp table row by row (iOS's SQLite may cap bound variables at
  999), changed rows upserted only when strictly newer than what is
  stored (a write-through that landed after the fetch wins), rows absent
  from the snapshot removed only when older than the pass stamp (a row a
  concurrent mutation just mirrored survives). `EKEventStoreChanged`
  (helper event line / Expo module event) runs a debounced reminders-only
  pass under the same gate — latency only; the 90 s pass is the
  correctness mechanism, because the notification reaches a live
  observer only. The helper reads stdin on a background thread and runs
  `dispatchMain()` on its main thread: EventKit posts the notification on
  the main queue, and a main thread blocked in `readLine()` never
  delivered it — the change push was silently dead on desktop until the
  real-EventKit e2e asserted it.
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
  INSERT (calendars, events, task lists, tasks, sync_state) is
  `INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ?)`,
  so a pass that finishes after `accountRepo.remove` writes nothing —
  without it the finishing pass recreated rows no later pass would ever
  touch. `replaceMirror` reports `skipped` and the engine ends the pass
  without stamping sync_state; removal itself is one transaction.

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
  single query surface (views, find-a-time, any future CLI/agent).
- **Ids**: a single event is its `eventIdentifier`; an occurrence of a
  series is `<eventIdentifier>__<occurrenceDate>` with
  `recurringEventId`/`originalStartUtc` set — the same shape
  `assembleWindow` gives Google occurrences, stable when one occurrence
  is moved on its own (occurrenceDate names its slot, not its start).
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
  mutation layer rejects them. A `reader` calendar opens as a viewer.
- **Moving between calendars** (`moveEvent`, always the whole series):
  Google → same Google account = queued `events.move` (keeps everything;
  organizer only; a create never sent becomes a create in the target, a
  sent one stays queued in the source with the move behind it, since it
  may have landed there); Apple → Apple = `event.calendar = target` saved with
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
an allow-list of fields, so a calendar can be shared without the details.

- **A run is a reconcile, not a sync.** What should exist is computed from
  the sources (`loadMirrorItems` → `buildMirrorCopies`), what exists is
  read from the destination by its markers, and `planMirror` writes the
  difference. Nothing remembers which copy belongs to which source: the
  destination is the state. So any device can run a mirror, a run cut off
  by the OS simply runs again, and two devices running the same mirror
  agree — provided their inputs agree, which is why sources are read with
  their own queries (local show/hide is ignored), "today" and the window
  are computed in the mirror's own `timeZone`, and source keys are
  portable (Google ids; EventKit's external identifier, new on both
  bridges, since `eventIdentifier` differs per device).
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
  source's.
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
  the event first and stands back from a newer revision, rather than
  replacing it with the older definition's content.
- **Triggers.** A change to events, tasks, calendars, accounts or the
  definitions marks the inputs dirty; a finished sync pass runs the
  mirrors (cheap gates first, the heavy part only when dirty); a heartbeat
  follows midnight in each mirror's zone (undated and overdue tasks move
  to today). An empty pull page no longer invalidates `EVENTS_KEY`, or
  every quiet poll would expand months of events. iOS runs a budgeted pass
  at the end of the background task; a first fill is foreground work.
- **Storage.** Definitions in `device_settings` `mirrors` (portable: the
  `mirrors` section of the settings document, import adds or updates,
  never removes, and an imported mirror arrives switched off); on/off,
  status, the newest revision seen and the rewrite journal in
  `mirrors.local`, this device's own. Copies are hidden in
  `EventRepo.getWindow` and the Apple read-through: the originals are
  already drawn.
- **Tasks** become events by one rule shared with the views
  (`taskCalendarDate`): open on the due day, or today once past or when
  undated; completed on the due day, or the completion day when undated
  or late. A completed task's copy gets a "✓ " prefix.

## Search (core `search/`, packages/sync/src/search.ts)

- **One rpc**, `search({ query, timeZone })`, handled by `searchCalendar`
  for both apps, "now" from Effect's Clock. It reads what the views can
  show: events through `loadEventsInRange` (visible calendars, series
  expanded with their overrides, mirror copies and cancelled events left
  out, Apple events through EventKit) over SEARCH_WINDOW_YEARS (two)
  either side of today in the primary zone, and every task of the visible
  lists (`TaskRepo.getVisible`). The range query's `keep` predicate is
  asked before expansion, so only the series that match are expanded;
  overrides stay whole so a cancelled or moved occurrence still shadows
  its slot. Events outside the window are not found; full-text search over
  the stored rows is the way past it (backlog, "Ask your calendar").
- **Matching is TypeScript, not SQL** (`searchTerms`,
  `eventMatchesSearch`, `taskMatchesSearch`): NFD with the combining marks
  dropped, lowercased without a locale; every word of the query must occur
  in one field — an event's title, place, notes, guest names and
  addresses, a task's title and notes. SQLite's LIKE folds neither accents
  nor non-ASCII case.
- **Results** (`buildSearchResults`): one hit per series, keyed by account,
  calendar and `recurringEventId` (Google's expanded instances and its
  overrides carry the master's id, EventKit's occurrences the series'
  `eventIdentifier`), at its next occurrence that is not over, else its
  latest past one. Upcoming soonest first, past most recent first, tasks
  open by due day, then undated, then completed latest first; 50 per group,
  each with its total. All-day events are judged by their dates in the
  zone, not by their UTC midnights.
- **UI**: `useSearch` (app-state) debounces 200 ms and keeps one atom per
  query in the bounded LRU, so a late answer for an earlier query never
  shows; the previous results stay up while the next load (`stale`), and
  the atoms re-run on EVENTS_KEY and TASKS_KEY, so an edit or a delete made
  from a result updates the list. The agent gateway has no search tool yet.

## Recurring events

- Masters carry `recurrence` (raw RFC 5545 lines, no DTSTART — derived from
  the event start in `packages/core/src/recurrence/expand.ts` via rrule-temporal;
  every `RRuleTemporal` is given the app's `Temporal` namespace through its
  `temporal` option, so occurrences are `@js-temporal/polyfill` instances on
  both platforms instead of native Temporal where the runtime has it).
- The UI never sees masters directly: `assembleWindow` expands them into
  synthetic instances with id `<masterId>__<originalStartUtc>` carrying
  `recurringEventId` + `originalStartUtc`.
- Editing scopes (`packages/core/src/recurrence/editing.ts` + mutations):
  - **instance** — materialize an exception row under Google's canonical
    instance id `<masterId>_<YYYYMMDDTHHMMSSZ>` (`<YYYYMMDD>` all-day);
    deletes write `cancelled` tombstones. Using Google's own id makes the
    later sync upsert idempotent.
  - **series** — patch the master; time edits apply the occurrence's
    wall-clock delta (`applyWallClockDelta`, DST-safe). A new rule
    (`changes.recurrence`, RFC 5545 lines) replaces the master's and
    drops its exceptions — they belonged to occurrences of the old rule,
    which is what Google does with them; `null` ("does not repeat")
    leaves the master as a single event at its own start. Google keeps a
    rule whose key is absent from a PATCH, so the op carries
    `recurrenceCleared` and the patch sends `recurrence: []`.
  - **following** — truncate the old master's RRULE with `UNTIL = split−1s`
    (COUNT dropped), spawn a new master (COUNT recomputed by expansion,
    or the edit's own rule; `null` makes the occurrence a single event),
    cancel later overrides.
  - An instance never carries a rule and a single event does not become a
    series through an update (`RecurringEditUnsupportedError`).
- The editor reads a series' master with `getEvent` (`useEventMaster`) to
  seed its repeat fields — an occurrence row has no lines — and sends the
  rule only when those fields were edited. A read-through Apple series
  has no stored master, so its rule stays uneditable in the app.
- Dragging a recurring instance commits an instance-scope override.

## Time-grid gestures

- **Move and resize an event**: desktop `useEventDrag` (pointer capture,
  4 px threshold, 15-minute snap, days by column width); iOS
  `DraggableEventBlock` (250 ms long press, then drag; a bottom handle
  resizes). Both commit through the op queue.
- **Draw a new event's slot**: desktop `useSlotDrag` — press on empty
  grid space and drag up or down, release opens the editor with that start
  and end; only vertical travel counts toward the 4 px threshold, so a
  click that drifts sideways stays the hour click, and a drag whose column
  leaves the page (an arrow key navigates mid-drag) is dropped. iOS
  `DayColumn` — hold 300 ms on empty space (a one-hour slot appears from the
  quarter the finger touched down in), drag while holding to grow it,
  release opens the sheet with exactly the slot shown; a drag that moves
  before the hold completes scrolls or swipes as before. The hold slot only
  grows: down past the hour's end, or up once the finger is a quarter above
  the touch-down point, so the few points a finger drifts (about a minute
  each) never shorten it or shift it by a quarter. The slot stays in
  its column and snaps to 15 minutes; the math is shared
  (`packages/core/src/time/slotSelection.ts`: `minuteOfDay`,
  `slotFromDrag`, `slotFromHold`, `slotTimes`, worklets so iOS runs them on
  the UI thread), and the editors take it as `EventEditorSeed.initialTimes`
  (Task mode keeps the start as a Reminders due time).
- **A gesture that starts on an event never draws a slot**: desktop blocks
  stop propagation in their pointerdown, so the column never sees the
  press; iOS blocks are drawn above the column's gesture layer, so the
  touch never reaches it. Each hook suppresses the click its own release
  would otherwise turn into an hour click.

## Agent gateway (desktop)

Other agents on the Mac get in through one more door, not through the rpc
seam: a Unix socket in the main process (`apps/desktop/electron/agent/`)
that authenticates a per-agent token and then serves MCP or one CLI
command, both over the same tool set. Every call goes through
`callTool` (`packages/agent/src/gateway.ts`) on the backend runtime —
the same services the renderer's rpc handlers use, with the agent
store's services (a second, tiny runtime over `agents.db`) provided into
each effect. The backend itself has no caller identity or permission
checks, so the gateway carries all of it: grant levels per calendar and
list, resolution of a write's real container, the guests capability,
ask-first approvals and the activity log. Details, limits and the threat
model: `docs/agent-gateway.md`.

## Platform seams

- Calendar data crosses process boundaries **only** through the typed rpc
  seam (Apple events included). Window-level concerns use plain preload IPC: `logError`
  (renderer errors → `userData/logs/main.log`, 1 MB rotation),
  `privacyGet/Set` (screen-capture protection, default hidden), the
  window-open handler (Join-meeting → system browser), and `agents:*`
  (agent grants and approvals — device-local, never rpc, never exported).
- The main process is single-instance per profile
  (`requestSingleInstanceLock`, taken after the `CALENDAR_USERDATA`
  override) and keeps running without a window on macOS; `windows.ts`
  opens one on demand (Dock, a notification click, a second launch).
  `--background` starts without a window — what the agent relay passes
  when it has to launch the app.
- Two windows, one renderer bundle. `renderer/main.tsx` mounts the
  calendar, or the settings window when the page was loaded at
  `#settings` (`windows.ts` `showSettingsWindow`). Settings is opened from
  the application menu (`menu.ts`: Settings…, ⌘,) — also with no main
  window — or over `settings:open` from the sidebar footer's "Manage
  accounts…"; there is one at most, fixed-size (780×560), with minimize
  and zoom off. The page is a sidebar of panes with a search field
  (`filterPanes`: label + keywords, the pane in view stays) and the pane's
  title over its content. The pane is the
  URL hash (`#settings/<pane>`): the main process moves an open window by
  navigating the hash, which the page sees as `hashchange` without a
  reload (a pane asked for while the page still loads is applied when
  loading stops), and a sidebar click navigates the hash too — the page
  reads the pane from the hash and never writes its own state over it. Each window is its own
  rpc client (`webContents.id`) with its own atoms, kept in step by the
  invalidation stream; `privacy:changed`, `agents:changed` and
  `settingsFile:changed` are sent to every window. The agent approval
  dialog, the conflict banner and the dropped-change toast live in the
  main window only.
- Auto-update (`update-electron-app` + Forge GitHub publisher) is wired
  but inert: builds are signed now, so the remaining blocker is that the
  repo (and thus Releases) is private — update.electronjs.org only serves
  public repos.
- Theme: `brand/tokens/tokens.json` is the one source. `pnpm brand:build`
  writes `brand/tokens/tokens.css` (semantic variables under `:root` and
  `[data-theme='dark']`) and `packages/core/src/theme/tokens.ts` (the same
  as a typed `THEMES.light/dark`), both guarded by `brand:check`. The
  desktop imports the CSS; `App.css` maps every variable into Tailwind's
  theme (`bg-canvas`, `bg-fill`, `text-ink`, `border-hairline`,
  `bg-primary`, …) and `renderer/theme.ts` mirrors `prefers-color-scheme`
  — which Electron feeds from `nativeTheme`, no IPC — onto `data-theme`
  on `<html>` before the first paint. iOS reads the TS module through
  `useTheme()` (`useColorScheme`). Calendar colors are arbitrary hex, so
  every calendar-colored block or chip goes through `eventTint(hex,
  scheme)`: hue and chroma from the calendar, lightness from the theme,
  text on fill at 4.5:1 for every palette entry; the brand `event-*`
  tokens are for items with no calendar.
- Desktop shell (`renderer/calendar/`): one toolbar (`Toolbar.tsx`:
  sidebar toggle, title, ‹ Today ›, the always-visible quick-add field
  with the "Understood as" review card, Day/Week/Month, Search, New), a
  collapsible sidebar (`sidebar/`: mini month, calendars and lists per
  account, the sync footer), the grid, and a side panel on the right
  (`panel/`): the Today rail at rest (Up next + task inbox + add-task),
  search (`SearchPanel.tsx`, ⌘F or the toolbar's Search), an event's
  inspector after a grid click or a search result (`EventInspector.tsx`,
  read first: Join, RSVP, series scope, Delete, Edit), or the inline
  editor (`EditorPanel.tsx`, 360px) from Edit, a slot, New, a task chip
  or result, or a task phrase. `CalendarApp.tsx` holds that as one
  `PanelState`; a panel opened from a search result carries `fromSearch`
  and closes back to the results (its inspector shows "‹ Results"), and
  Escape steps back one level. The search itself runs in `CalendarBody`,
  so it stays current while a result is open. The panel never joins the
  dialog stack, so a real dialog over it (the agent approval, capture, a
  birthday) keeps Escape, and ⌘F stands back under a dialog and over an
  open editor. The drag hook
  (`useEventDrag`) is owned by the app, not the week view, so the panel's
  task rows drag onto the grid and lane too (a `'panel'` origin with a
  pointer-following ghost). `lastView` and `sidebarCollapsed` are read
  from the view preferences before the first paint.
- iOS shell (`apps/ios/app/`, expo-router): `_layout.tsx` mounts the
  providers, the system background, the editor host and a native stack
  with the tab bar (`(tabs)/`: Calendar · Tasks · Search, the last a
  stack of one screen whose `Stack.SearchBar` is the system search field,
  which iOS 26 shows in the tab bar for the search role) and Settings as
  a modal route holding its own native stack (`settings/`: the root list,
  a page per pane, the pages under them; `src/ui/settings/`). `src/ui/CalendarScreen.tsx` is the calendar tab: a
  header (title, view menu, ‹ Today ›, gear), the week strip, the
  timeline / month grid / agenda, and the floating "+". `EditorHost.tsx`
  owns every sheet — quick add, event detail, the editors, the birthday
  detail, the capture review — and the capture model behind the share
  sheet and deep links; screens ask it through `useEditorHost()`.
  `+native-intent.tsx` keeps non-route URLs on the calendar.
- Views: day/week (time grid with wheel-pan on desktop, swipe paging on
  iOS), month grid, and an all-day lane that hosts date-only tasks. Timed
  Apple Reminders share the day-column overlap layout with events as compact,
  move-only blocks; their due time is wall-clock data, not an event duration.
  Each 22-point block reserves 30 visual minutes for overlap packing, with
  late-night blocks clamped inside their due day. Packing uses the rendered
  coordinates so reminders and events cannot cover one another on DST days.
  Dragging snaps to 15 minutes, applies a Temporal wall-clock delta, and
  updates only changed due fields through the existing task mutation.
- Birthdays are a third all-day kind, not events: `getBirthdaysInRange`
  merges the Google People cache and the device snapshot
  (`DeviceContacts.birthdays()`, `CNContactBirthdayKey`) by folded name +
  MM-DD (`mergeBirthdays`), expands occurrences per day (Feb 29 lands on
  Feb 28 in common years), and both lanes draw a neutral chip with a
  fixed pink accent (`birthdayChipLabel`). The detail view lists every
  source; the birthday itself is read-only, and the one thing it edits
  is that person's reminder lead days (below). Month views show tasks and birthdays too, as
  read-only summaries after the day's events (events keep the cap — they
  carry the calendar's color — then birthdays, then tasks): chips on
  desktop under the same three-chip cap, dots on iOS under the four-dot
  cap; both cells announce the counts through `monthCellLabel` (core);
  tapping a cell opens the day, where the full chips live. Both kinds are
  bucketed with `groupByDate` (core), which the iOS all-day lane uses as
  well.
- Event locations and maps: Google stores only location text, so
  coordinates (`EventRecord.geo`: lat, lng, name, and `source`, the text
  they came from) are derived on-device through `GeoClient` (MapKit via
  the helper / the `solunivo-geo` Expo module) and are valid only while
  `source` matches the location (`geoMatches`). They travel in the
  event's private extendedProperties, so other devices skip geocoding.
  Only coordinates the user vouched for are mirrored: the event's own or
  a picked suggestion. A local edit that drops them (the location
  changed) flags its queued update `geoCleared`, and only that PATCH
  deletes the keys with nulls — an unrelated edit never touches
  extendedProperties. A pull whose source no longer matches (edited in
  another client) ignores the keys; they stay on the server until the
  next pick overwrites them. Events without mirrored coordinates are
  geocoded when the editor opens (`resolveLocation`, cached per
  normalized string in the device-local `location_geo` table: misses
  for 3 days, hits served at once and re-resolved in the background
  once older than 14 days — the write invalidates `LOCATION_GEO_KEY`, so
  an open editor follows — pruned to 2000 rows, wiped from Settings)
  for the map on this device only; typing
  never geocodes — the typeahead (`searchPlaces`,
  MKLocalSearchCompleter) and a picked row do. URLs and meeting links
  are never looked up. Desktop
  draws a static `MKMapSnapshotter` PNG (`mapSnapshot`); iOS draws a live
  `expo-maps` Apple Maps view (iOS 17+, else only the Open in Maps link).
- Device-only data behind rpc: `device_settings` is a key/value table
  for preferences that never sync (birthday reminders first;
  `birthdayReminderOverrides` holds per-person lead days, each person
  named by display name + month + day and matched through
  `birthdayMergeKey`, so an override survives a source coming or going —
  the merged record's id does not — and means the same person on every
  device). The
  IPC-vs-rpc rule is about window concerns, not about where data lives —
  SQLite is per device and never uploaded, and the consumer of these
  settings is a backend job that runs inside both hosts.
- Local notifications: `LocalNotifications` (packages/sync) runs its own
  loop — deliberately outside the sync pass, so the engine carries no
  notification dependency — over two producers, `loadEventPlans`
  (event reminders: visible calendars, a week ahead, `useDefault`
  resolved against the calendar's `defaultReminders`, Apple Calendar
  events only when the setting includes them) and `loadBirthdayPlans`
  (a person's own lead days, when they have an override, replace the
  general ones; the general switch gates both), merged into one `PlannedNotification` list sorted by delivery. A
  producer whose setting is off returns nothing; the OS schedule is
  cleared only when both do. The platform `NotificationSink` delivers:
  desktop fires an Electron `Notification` when one is due and, after
  sleep, only while the plan's `expiresAt` allows (a birthday all day,
  a meeting until five minutes in; fired keys kept in
  `device_settings`), iOS replaces the pending expo-notifications
  schedule with the soonest ≤ 60 whenever the digest changes. The loop
  sleeps until the next delivery (5 s..60 s) and re-plans, debounced,
  on every `EVENTS_KEY` / `BIRTHDAYS_KEY` invalidation; a settings write
  is not one of those, so each settings path runs a pass itself. An immediate
  sink is asked for permission once, on the first pass with a producer
  enabled (desktop's ask is the "Notifications are on" banner). "The
  notification is latency, the pass is correctness" applies. On iOS a
  background task (`apps/ios/src/backgroundTask.ts`, defined before the
  root component registers) runs `backgroundRefresh` when the OS grants
  it: a pull bounded to 20 s, then one pass, so the 60 slots refill and
  remote additions get scheduled without a launch.
- Event reminders are data on the record (`EventRecord.reminders`,
  Google's `useDefault`/`overrides` shape; `useDefault:false` with no
  overrides is "none", distinct from the field being absent), mirrored
  from Google and from EventKit alarms (`useDefault` always false — the
  bridge flips the sign once). A PATCH carries the whole object only
  when the op is flagged `remindersChanged`, since Google replaces it
  and email overrides must survive an unrelated edit.

- The task editor forks on the selected list's provider
  (`useTaskEditorModel.provider`): Google gets title/day/notes with a
  fixed list; Reminders get time, priority, alert, repeat (shared
  `useRepeatState`), URL, and a movable list. Both platforms keep the
  same testIDs/labels on the shared controls.
- Time is Temporal everywhere (`@js-temporal/polyfill` via
  `packages/core/src/time/temporal.ts`); Hermes needs the `Intl.resolvedOptions` shim in
  `packages/core/src/time/intl-compat.ts`.
