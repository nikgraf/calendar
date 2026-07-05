# TODO

## Follow-ups

- [ ] Real app icons (macOS .icns / Assets.car, iOS app icon set)
- [ ] Signing/notarization for the macOS app — already env-gated in
      `apps/desktop/forge.config.cjs` (`APPLE_SIGNING_IDENTITY`, `APPLE_ID`,
      `APPLE_PASSWORD`, `APPLE_TEAM_ID`); needs Apple credentials
- [ ] EAS build / TestFlight distribution for the iOS app
- [ ] Native iOS date/time pickers in the event editor
      (`@react-native-community/datetimepicker` — replaces the text inputs;
      requires a prebuild)
- [x] Drag-to-move / drag-to-resize events — done: pointer-event drag on
      desktop (move across days + resize, 15-min snap, Escape cancels,
      click-through preserved), long-press pan + resize handle on iOS via
      gesture-handler/reanimated; shared snap math in core/time/dragMath.ts.
      Out of v1 scope: all-day chips, month view, recurring events
- [x] Recurring-event editing — done: `updateRecurring`/`deleteRecurring`
      rpcs with scope `instance` (exception rows under Google's canonical
      `master_basetime` instance id, cancelled tombstones for deletes),
      `series` (delta-shifted master patch), and `following` (RRULE UNTIL
      truncation + new master with recomputed COUNT; later overrides
      cancelled). Scope picker in both editors; dragging a recurring
      instance commits a single-instance override.

## Features

- [x] Create recurring events — done: `buildRecurrenceRule` in core
      (freq + interval + end-after-count / end-on-date; RFC 5545 defaults
      keep the series on DTSTART's weekday/day-of-month), optional
      `recurrence` on `EventDraft`, repeat pickers in both editors
      (create mode). Custom BYDAY combinations stay out of scope for now.
- [x] RSVP on invitations — done: `respondToEvent` rpc + dedicated `rsvp`
      op kind sending an attendees-only patch (no If-Match — a response
      shouldn't lose to unrelated content edits), own entry matched via
      `isSelf`/account email, RSVPs survive content-edit coalescing.
      Accept/Maybe/Decline buttons in both editors; responding from a
      recurring instance answers for the whole series.
- [x] "Join meeting" detection — done: `hangoutLink` mapped from Google
      (`hangoutLink` or the conferenceData video entry point, new
      `hangout_link` column via migration 2), `meetingUrl()` in core also
      scans location/description for Meet/Zoom/Teams/Webex/Whereby URLs;
      Join button in both editors (desktop opens via the system browser
      through a window-open handler, iOS via `Linking`).

## Robustness

- [ ] Surface failed/pending ops — `PendingOp` retries with backoff but
      failures are invisible (`markFailed` with 'transient failure'). A small
      "N unsynced changes" indicator plus a way to see/discard a stuck op
      would prevent silent data divergence. Same for 412 server-wins: it
      currently discards your edit with no toast.
- [ ] Re-auth flow when a refresh token dies — `Account.status` can go to
      error, but there's no "Reconnect" affordance in
      AccountsView/SettingsSheet that re-runs OAuth for the existing account.
- [ ] Sync on wake/focus — the ~90s poll doesn't fire immediately when the
      laptop wakes or the app regains focus (`powerMonitor` on Electron,
      `AppState` on iOS). Cheap, and it's when staleness is most visible.
- [ ] DST-aware drag/series math — `moveEventTimes` shifts absolute ms, so
      dragging an event across a DST boundary shifts its wall time by an
      hour; same for series-scope delta shifts. Fix is doing the arithmetic
      in the event's zone via Temporal.
- [ ] `eventsInRange` atom-family growth — the family is keyed by
      `${start}:${end}` and never evicted, so long navigation sessions
      accumulate atoms/subscriptions. Worth checking `Atom.family` eviction
      options or normalizing keys to week boundaries (which also enables
      prefetching week±1 for instant navigation).

## Infrastructure

- [x] CI — done: `.github/workflows/ci.yml` with a `gate` job (ubuntu:
      check + typecheck + unit tests) and an `e2e` job (macos-14:
      electron-rebuild, desktop build, CDP e2e suite) on pushes to main
      and PRs.
- [ ] Electron auto-update — pairs with the signing todo;
      `update-electron-app` + a Forge publisher is little work once
      notarization exists.
- [ ] iOS e2e via Maestro — the gap we noted when building the desktop
      suite; gestures and the scope picker are only unit-covered on iOS.
- [ ] Renderer error boundary + a log file — one uncaught render error
      currently white-screens the window; and there's no persisted log to
      debug a failed sync after the fact (Effect's Logger to a rotating
      file in userData would do).

## Deferred architecture upgrades

Both were deliberately deferred during the initial build and have clean
upgrade paths:

- [x] Migrate UI state/data flow to `@effect/atom-react` — done: atoms
      subscribe to fine-grained Reactivity keys (`accounts`/`calendars`/
      `events`); backend invalidations flow through a forwarding bridge
- [x] Replace the hand-rolled Schema-typed IPC bridge with
      `effect/unstable/rpc` — done: `AppBackendRpcs` RpcGroup in core,
      custom duplex protocols over the Electron IPC frame channel
      (`packages/sync/src/rpcDuplex.ts`; a MessagePort transport is a
      drop-in duplex swap), and the invalidation stream is a typed
      `stream: true` rpc
