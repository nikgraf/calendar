# Architecture

Client-only: both apps talk directly to the Google Calendar and Google
Tasks REST APIs, and to Apple Reminders through EventKit. There is no
server of ours; all state lives in a local SQLite database per device and
reconciles against Google / EventKit.

## Data flow

```
React UI (desktop renderer / iOS)
  │  useAccounts / useCalendars / useEventsInRangeStable / usePendingOps
  │  useTaskLists / useTasksInRangeStable / useNow
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
  │                                       packages/db/src/repos.ts)
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
```

Invalidation path (backend → UI): repo mutations invalidate Reactivity keys
(`accounts`, `calendars`, `events`, `pendingOps`, `tasks`, `taskLists`,
plus `notice:conflict` as a broadcast-only signal). `forwardingReactivity`
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

| kind            | eventId                       | payload/fields          | remote call                                        |
| --------------- | ----------------------------- | ----------------------- | -------------------------------------------------- |
| `create`        | client-generated id           | full EventRecord        | events.insert (idempotent — 409 = already landed)  |
| `update`        | event id / instance id        | full EventRecord        | events.patch (If-Match when etag known)            |
| `delete`        | event id / instance id        | —                       | events.delete                                      |
| `rsvp`          | event id                      | EventRecord (attendees) | events.patch, attendees-only body, **no If-Match** |
| `calendarColor` | `__calendar_color__` sentinel | `colorHex`              | calendarList.patch?colorRgbFormat=true             |
| `createTask`    | temp `local-…` id             | title/notes/due         | tasks.insert (NOT idempotent — see below)          |
| `updateTask`    | task id                       | title/notes/due         | tasks.patch                                        |
| `completeTask`  | task id                       | completed flag          | tasks.patch (status + hidden reset)                |
| `deleteTask`    | task id                       | —                       | tasks.delete (404/410 = already gone)              |

Rules that keep the queue correct:

- **Coalescing**: a content edit removes prior ops for the same
  (calendarId, eventId) and re-enqueues (a queued `create` absorbs edits);
  `removeForEvent` deliberately spares `rsvp` ops; `calendarColor` ops
  coalesce **per account** under the sentinel (the same shared calendar id
  can exist under several accounts).
- **Backoff**: transient failures retry at `30s·2^attempts`, capped at
  30 min (`markFailed`). Non-409 4xx (except 429) are permanent → drop.
- **412 Conflict**: server wins — the op is dropped and `notice:conflict`
  is broadcast; the desktop shows a toast. The next pull replaces the local
  copy.
- **401**: the op stays queued, the account is flagged `reauth_required`;
  reconnecting (same account id, resolved by email) resets status and the
  queue drains.
- **Provider dispatch**: `completeTask/createTask/deleteTask/updateTask`
  look up the account's provider. Google lists take the queue path
  below; Apple lists call EventKit synchronously via `reminderMutations`
  and write the result through (`upsertTasks`), so a created reminder has
  its real id from the start. Reminders-only fields (time, priority, url,
  alarms, recurrence, `moveToListId`) on a Google list fail with
  `UnsupportedForProviderError`.
- **Task creates are not idempotent**: Google assigns task ids
  server-side, so a `createTask` writes a temp `local-…` row that is
  swapped for the server task on success (`rewriteEventId` renames the
  queued op; the row is remove+upsert, never an id UPDATE — a concurrent
  pull may already have inserted the server row). Before retrying a
  `createTask` that was already **dispatched** (`dispatched_at` stamp),
  the drain first lists recent tasks and adopts a match — otherwise a
  crash between insert and ack would duplicate the task.
- The drain loop re-reads each op by id before dispatching: a missing row
  means the user discarded it (skip), and coalescing rewrites stay
  visible.
- The op queue is surfaced in the UI (`listPendingOps`/`discardPendingOp`
  rpcs, "N unsynced changes" panel). `PendingOpSummary` in core/backend.ts
  has its **own kind literal** — extend it whenever a kind is added.

## Sync engine (packages/sync/src/engine.ts)

- Poll every ~90s + immediate kicks on wake/unlock/window-focus (desktop
  `powerMonitor`) and `AppState` active (iOS), debounced 15s.
- `syncAll` is semaphore-serialized and always **pushes pending ops before
  pulling** — that ordering is what protects optimistic local writes from
  being overwritten by a pull (ops in backoff are the one exception; the
  `calendarColor` apply upserts the patch response to self-heal that case).
- Incremental pulls use syncTokens; a 410 forces a full resync, after which
  `deleteStale` purges rows the server no longer returns (pending rows are
  protected by sync_status).
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
- **Apple Reminders** (the synthetic `apple-reminders` account, created by
  the `connectReminders` rpc after the EventKit prompt): SQLite holds the
  latest **complete** EventKit snapshot — open and completed, dated and
  undated (undated rows are stored for the future list view; `getWindow`
  excludes them), so paging any distance ahead or back reads locally,
  like Google Tasks. `syncReminders` checks authorization first — no
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

## Recurring events

- Masters carry `recurrence` (raw RFC 5545 lines, no DTSTART — derived from
  the event start in `packages/core/src/recurrence/expand.ts` via rrule-temporal).
- The UI never sees masters directly: `assembleWindow` expands them into
  synthetic instances with id `<masterId>__<originalStartUtc>` carrying
  `recurringEventId` + `originalStartUtc`.
- Editing scopes (`packages/core/src/recurrence/editing.ts` + mutations):
  - **instance** — materialize an exception row under Google's canonical
    instance id `<masterId>_<YYYYMMDDTHHMMSSZ>` (`<YYYYMMDD>` all-day);
    deletes write `cancelled` tombstones. Using Google's own id makes the
    later sync upsert idempotent.
  - **series** — patch the master; time edits apply the occurrence's
    wall-clock delta (`applyWallClockDelta`, DST-safe).
  - **following** — truncate the old master's RRULE with `UNTIL = split−1s`
    (COUNT dropped), spawn a new master (COUNT recomputed by expansion),
    cancel later overrides.
- Dragging a recurring instance commits an instance-scope override.

## Platform seams

- Calendar data crosses process boundaries **only** through the typed rpc
  seam. Window-level concerns use plain preload IPC: `logError`
  (renderer errors → `userData/logs/main.log`, 1 MB rotation),
  `privacyGet/Set` (screen-capture protection, default hidden), and the
  window-open handler (Join-meeting → system browser).
- Auto-update (`update-electron-app` + Forge GitHub publisher) is wired
  but inert: builds are signed now, so the remaining blocker is that the
  repo (and thus Releases) is private — update.electronjs.org only serves
  public repos.
- Views: day/week (time grid with wheel-pan on desktop, swipe paging on
  iOS), month grid, and an all-day lane that also hosts the task rows —
  timed reminders lead with their time and priority marker
  (`taskChipLabel`) rather than moving into the time grid.
- The task editor forks on the selected list's provider
  (`useTaskEditorModel.provider`): Google gets title/day/notes with a
  fixed list; Reminders get time, priority, alert, repeat (shared
  `useRepeatState`), URL, and a movable list. Both platforms keep the
  same testIDs/labels on the shared controls.
- Time is Temporal everywhere (`@js-temporal/polyfill` via
  `packages/core/src/time/temporal.ts`); Hermes needs the `Intl.resolvedOptions` shim in
  `packages/core/src/time/intl-compat.ts`.
