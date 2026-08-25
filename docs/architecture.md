# Architecture

Client-only: both apps talk directly to the Google Calendar REST API. There
is no server of ours; all state lives in a local SQLite database per device
and reconciles against Google.

## Data flow

```
React UI (desktop renderer / iOS)
  │  useAccounts / useCalendars / useEventsInRange / usePendingOps
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

AI (desktop): renderer → preload IPC → main → Swift helper
(apps/desktop/helper, Foundation Models + SpeechAnalyzer over stdio
JSON); iOS reaches the same models via @react-native-ai/apple.
```

Invalidation path (backend → UI): repo mutations invalidate Reactivity keys
(`accounts`, `calendars`, `events`, `pendingOps`, plus `notice:conflict` as
a broadcast-only signal). `forwardingReactivity`
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
- Auto-update (`update-electron-app` + Forge GitHub publisher) is wired but
  inert until the app is signed and releases exist.
- Time is Temporal everywhere (`@js-temporal/polyfill` via
  `packages/core/src/time/temporal.ts`); Hermes needs the `Intl.resolvedOptions` shim in
  `packages/core/src/time/intl-compat.ts`.
