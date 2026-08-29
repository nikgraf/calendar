# TODO

## Follow-ups

- [x] App name — decided: **Solunivo** (no trademark hits, solunivo.com
      purchased; latent sol+luna+novo reading). Renamed product surfaces:
      packager name/executable, bundle ids (desktop com.solunivo.desktop,
      iOS com.solunivo.app), window/OAuth-page titles, sidebar brand,
      core appName, CI artifact + verify paths, docs. Internal @calendar/\*
      package scopes and the GitHub repo name intentionally kept. The
      Google Cloud iOS OAuth client was recreated for the new bundle id
      (#23); packaged-app userData moved (Application Support/Solunivo)
      so testers re-authed once.
- [ ] Real app icons (macOS .icns / Assets.car, iOS app icon set)
- [x] Signing/notarization for the macOS app — done: the `testing-build` job
      ships a signed + notarized arm64 zip artifact on every main push and has
      been green since the secrets landed. Decisions: no universal build,
      artifact-only, no auto-update while the repo is private. See
      `docs/distribution.md`.
- [x] EAS build / TestFlight distribution for the iOS app — done: EAS
      Build+Submit on every main push (fire-and-forget from ubuntu CI) plus
      per-PR OTA preview channels (pr-<n>, ~30s) with an in-app channel
      switcher (Settings → PR preview, expo-updates header override);
      `testflight` PR label ships a real build for native changes
      (fingerprint runtimeVersion keeps incompatible OTA updates away).
      Decisions: single bundle id (one install per device — platform
      constraint), no per-PR TestFlight builds by default (cost/latency).
      One-time setup (first interactive build, EXPO_TOKEN secret, ASC
      app) is complete and the pipeline has shipped builds + OTA updates.
      See docs/distribution.md. Note: the OAuth consent
      screen is in Testing, where refresh tokens expire after 7 days —
      publish to Production before adding outside testers, or they hit a
      weekly forced re-sign-in.
- [x] Native iOS date/time pickers in the event editor — done (#33):
      `@react-native-community/datetimepicker` inline date + spinner time
      pickers replace the text inputs (event editor + task due date);
      repeat-until seeds on switching Ends→on so it can't silently stay
      unbounded.
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

## AI features

Decision: **on-device models only** — no data leaves the device, no API keys, no
per-request cost, works offline. This matches the app's existing posture (client-only,
screen-share protection, tokens outside SQLite). Apple's Foundation Models (~3B,
iOS/macOS 26) handle extraction and classification well but not multi-step reasoning,
so the rule throughout is: **the model parses intent, deterministic code does the
work** — which also keeps the valuable logic in `packages/*` where it is unit-testable
with a fake provider.

Platform notes: iOS reaches the models through `@react-native-ai/apple` (structured
JSON output, embeddings, transcription; RN 0.80+ and the new architecture, both
already in place). Speech is `SpeechAnalyzer`/`SpeechTranscriber`, on-device on **iOS
26 and macOS 26**, ahead of Whisper Small on accuracy, installing per-locale assets on
first use. Electron has no on-device path yet — Foundation Models is Swift-only — so
desktop waits on a helper binary (below).

- [x] Natural-language quick add — done on BOTH platforms: iOS text +
      dictation in the quick-add bar (shipped earlier), desktop via the
      ⌘K command bar on the helper runtime (below). One shared parser
      (`parseQuickAdd`), one prefilled-editor hand-off, never an
      auto-save.
- [x] Find a time (iOS) — done: a ⏱ mode in the quick-add bar; the model
      only parses the constraint sentence (`parseFindTime`, mirroring the
      quick-add stack: dated-weekday prompt list, vocabulary anchors like
      "mornings" → 08:00–12:00, placeholder stripping, normalize/reject),
      and the pure `findFreeSlots` solver in core does the work over the
      already-assembled `getEventsInRange` window — wall-clock daily
      bounds (DST-correct), all-day events don't block, no past slots,
      one chronological slot per gap, capped at 10. Tapping a slot chip
      prefills the editor via the existing EventEditorPrefill path.
      Decisions: chronological ranking v1 (constraints are the
      preference language), window defaults to the coming week, duration
      required. Desktop follows via the helper binary below — parser and
      solver are already shared; the ⌘K bar then carries quick add AND
      find-a-time.
- [ ] Capture from text or photo — paste an email (desktop) or share a
      screenshot/poster (iOS share sheet, using image input) → extracted event(s).
- [x] Voice capture (iOS) — done: mic in the quick-add bar records WAV/LPCM
      (`expo-audio`), transcribes on device via `SpeechAnalyzer` and feeds the
      transcript straight into the same parser; the recording file is deleted
      immediately. Availability is decided by attempting `prepare()` (which installs
      the locale's assets) rather than by the platform's readiness flag, because that
      flag is false until assets exist — gating on it would hide dictation on a
      capable device that had simply never used it. Reaches desktop with the helper
      binary, since macOS 26 exposes the same API — which it now has: desktop
      dictation ships in the ⌘K bar via the helper. Siri/App Intent entry point later.
      NOTE: the simulator has no speech assets, so dictation self-disables there —
      the transcript path needs a TestFlight check on a real device.
- [ ] Day briefing (iOS-first) — a short generated summary of the day; a widget or
      Live Activity candidate once it earns its place.
- [ ] Ask your calendar — start with SQLite FTS5, which honestly covers most recall;
      add on-device embeddings only if fuzzy recall proves necessary.
- [ ] Week planning / rescheduling assistant (desktop) — "make room for 3h of deep
      work" proposes a _diff_ of moves to approve, executed through the existing op
      queue so it stays inspectable and undoable. Most ambitious, and the weakest fit
      for a 3B model: keep the solving deterministic.
- [ ] Invite triage (desktop) — summarize a backlog of invitations, suggest
      accept/decline.
- [x] Desktop model runtime — done: one Swift helper
      (`apps/desktop/helper/`, SPM) exposing Foundation Models AND
      SpeechAnalyzer over a newline-JSON stdio protocol (status /
      generateJson via runtime-built DynamicGenerationSchema at temp 0 /
      prepareSpeech / transcribe). Weak-linked + #available-guarded, so
      the binary runs on any macOS and reports unavailable below 26.
      Main spawns it lazily (crash restart w/ backoff, request timeout),
      renderer reaches it over plain preload IPC (window-level concern —
      not the rpc seam); `desktopLanguageModel`/`desktopSpeech` implement
      the shared seams, with the renderer owning the microphone
      (getUserMedia → 16 kHz LPCM WAV, the iOS shape). Packaged via
      extraResource; `make`/`package:app` build it first; testing-build
      CI moved to macos-26 (only image with the SDK), e2e to macos-15
      (macos-14 deprecated). The ⌘K bar (quick add + find-a-time +
      dictation) is the proof feature. Swift 6 gotchas recorded in the
      helper commit: top-level code is MainActor-isolated (detach the
      per-request Task or the semaphore deadlocks), own-and-return
      accumulators across tasks.

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

- [x] Native text selection (desktop) — body-level `user-select: none`;
      re-enabled for inputs/textareas/contenteditable plus copy-worthy
      read-only text (error messages, account emails, invitee list).
      UI chrome (headers, labels, day numbers, buttons) is unselectable.
- [x] Screen-sharing privacy — done: the desktop window is excluded from
      screen shares/recordings by default (`setContentProtection`, macOS
      `NSWindowSharingNone`); Privacy section in the settings modal offers
      Hidden / Visible for 10 min (runtime-only, fails closed on restart) /
      Always visible (persisted in `userData/settings.json`).
- [x] Sync Google Tasks — done: task lists + tasks poll on `updatedMin`
      (watermark in sync_state.sync_token, captured pre-pass; tombstones
      via showDeleted; daily full pass + deleteStale because tombstones
      expire), `completeTask` op through the queue (optimistic setStatus,
      latest-wins coalescing, response upsert — which also picks up the
      server-materialized next occurrence of repeating tasks), chips with
      checkboxes in both all-day lanes, per-list visibility toggles.
      Decisions: separate GoogleTasksClient service (request core
      extracted; scope-insufficient 403 now maps to
      InsufficientScopeError instead of being silently dropped);
      `auth/tasks` scope added to the now-shared scope list — existing
      accounts re-consent by re-running "Add Google Account" (in-place
      upgrade), gated per account via `tasksEnabled` derived from granted
      scopes, so calendar-only tokens keep syncing untouched. `due` is
      date-only → date-string storage/query end to end. Out of v1: see
      the "Tasks:" follow-ups above.
- [x] Tasks: create/edit/delete from the app — done: both editors gained
      an Event | Task toggle (create) and open in task mode from a chip
      tap (edit/delete, incl. "Open in Google Tasks"). New op kinds
      createTask/updateTask/deleteTask; the Tasks API assigns ids
      server-side, so creates live under a temp local- id that the push
      swaps everywhere (row + queued ops; oldest-first draining makes
      the order safe). Edits fold into a still-queued create; deleting
      an unpushed create sends nothing. tasks.sync_status keeps the
      daily full-pass reconcile from eating unpushed local rows. Due
      date required (no task-list view yet); list fixed after create
      (moving needs tasks.move).
- [ ] Tasks: subtask hierarchy — render `parent`/`position` indentation
      and keep ordering via `tasks.move`
- [ ] Tasks: month-view presence (dots or counts for days with due tasks)
- [x] Tasks: detail sheet on chip tap — done as part of task
      create/edit/delete: the chip body opens the shared editor in task
      mode (notes, list, due, delete, open-in-Google via `webViewLink`).
- [x] Tasks: iOS Maestro flow for the all-day lane — done:
      `08-task-lane.yaml` creates a task via the editor toggle, asserts
      the chip renders, toggles the checkbox twice (restores state),
      opens the editor from the chip body, deletes. Targets the created
      chip via Maestro's regex ids matching the temp `local-.*` id, so it
      is deterministic even on accounts with real tasks — and traceless
      server-side because deleting an unpushed create sends nothing.
      No-ops without a tasks-enabled account (`task-list-option` guard,
      same shape as 06/07).
- [x] Per-calendar colors — done: swatch in the desktop sidebar opens a
      picker (Google's 24-color palette + native color input; palette
      chips on iOS settings); optimistic local update, then write-back via
      `calendarList.patch?colorRgbFormat=true` through a new
      `calendarColor` op kind (account-scoped coalescing, response upsert
      self-heals a backoff-window pull overwrite, invalid hex rejected,
      4xx dropped instead of retried forever). Custom colors round-trip:
      `mapGcalCalendar` already prefers `backgroundColor` over `colorId`.
- [x] Horizontal trackpad scroll pans days (desktop day/week) — done:
      continuous pan that follows the fingers 1:1, then eases to the
      nearest day when the wheel goes quiet (Nik rejected discrete-step
      snapping). Day columns render inside a clipped viewport as a wider
      strip (±`PAN_BUFFER_DAYS` buffer columns, fetch range extended to
      match) translated by a `--pan-x` CSS var written imperatively — no
      React render per wheel event. Pure pan machine in
      `core/gestures/wheelPan.ts` (axis lock per gesture, commit-on-day-
      crossing with `compensate()` re-anchoring in a pre-paint layout
      effect, snap-rounding on release); native non-passive listener
      (React's delegated onWheel is passive, preventDefault needs it).
      Week view is a rolling 7-day window via nullable `weekWindowStart` —
      Today/view switches snap back to the Monday week, ‹ › keep ±7d.
      `useEventsInRangeStable` holds the previous range's events while a
      new range atom loads so panning never flashes empty.
- [ ] Invitation autocomplete from device contacts (macOS/iOS) —
      prerequisite for both autocomplete items: the editors currently
      render attendees read-only, so attendee add/remove + Google's
      `sendUpdates` param on patch/insert must land first. iOS is easy:
      `expo-contacts` (permission prompt + prebuild). macOS is medium:
      Electron has no contacts API, so a native module
      (`node-mac-contacts`) in the main process plus the
      `com.apple.security.personal-information.addressbook` entitlement
      and a Contacts permission prompt — ties into the signing/
      notarization follow-up.
- [ ] Invitation autocomplete from Google contacts — feasible via the
      People API: `people.connections.list` (saved contacts) plus
      `otherContacts.list` ("people you've emailed" — this is what powers
      Google Calendar's own suggestions). Needs `contacts.readonly` +
      `contacts.other.readonly` scopes (re-consent) and the People API
      enabled in the GCP project. Cache per-account locally and merge
      with device contacts into one ranked typeahead.
- [ ] Show contact birthdays — likely the cheapest of the batch: Google
      exposes a built-in read-only Birthdays calendar
      (`addressbook#contacts@group.v.calendar.google.com`) through the
      normal calendarList, so if it's enabled in Google Calendar it may
      already sync today. Work: verify it survives our sync (annual
      recurrence, `eventType: 'birthday'`, read-only — the editor must
      not offer edits), give it a 🎂 chip style, and expose it as a
      toggleable calendar. Optional extension later: merge birthdays from
      device contacts (`expo-contacts` exposes them) for people not in
      Google contacts.

## Robustness

- [x] Surface failed/pending ops — done: reactive `OPS_KEY` on the op
      queue, `listPendingOps`/`discardPendingOp` rpcs, "N unsynced changes"
      panel in the desktop sidebar and iOS settings (per-op discard, retry
      count). 412 server-wins now broadcasts `notice:conflict` over the
      invalidation stream and the desktop shows a toast.
- [x] Re-auth flow when a refresh token dies — done: ops hitting a 401 now
      flag the account `reauth_required` (and stay queued for after the
      reconnect); iOS settings gets a tappable "Session expired — reconnect"
      running OAuth for the same account (stable id by email); desktop
      already had the AccountsView button, sidebar hint now reads as a
      warning.
- [x] Sync on wake/focus — done: Electron kicks `syncAll` on
      `powerMonitor` resume/unlock and window focus; iOS on `AppState`
      returning to active. Debounced to one kick per 15s; syncAll is
      semaphore-serialized so overlapping kicks are safe.
- [x] DST-aware drag/series math — done: `moveEventTimes` does wall-clock
      arithmetic in the event's zone (a 09:00 event dragged across the
      spring-forward day stays at 09:00; absolute duration preserved), and
      series-scope edits apply the occurrence's wall-clock delta via
      `applyWallClockDelta` instead of raw ms.
- [x] `eventsInRange` atom-family growth — done: replaced `Atom.family`
      with a 32-entry LRU keyed by range; revisiting an evicted range just
      refetches. (Prefetching week±1 remains a possible follow-up.)

## Infrastructure

- [x] CI — done: `.github/workflows/ci.yml` with a `gate` job (ubuntu:
      check + typecheck + unit tests), an `e2e` job (macos-15: desktop
      build, CDP e2e suite — no native rebuilds since node:sqlite), and a
      `testing-build` job (macos-26: signed+notarized zip) on pushes to
      main and PRs; `.github/workflows/ios.yml` handles fingerprint-gated
      iOS publishing.
- [x] Electron auto-update — done: `update-electron-app` runs in packaged
      builds (GitHub releases, 1h interval) and the Forge GitHub publisher
      is configured (draft releases). Signing/notarization is done; the
      remaining blocker is that the repo is private — update.electronjs.org
      only serves public repos, so this stays a no-op until the repo goes
      public or a token-fed feed replaces it.
- [x] iOS e2e via Maestro — done: eight flows in `apps/ios/e2e/flows/`
      (launch, navigation, new-event sheet, accounts sheet, day swipe,
      quick add, create-event save path, task lane) with testIDs on the
      icon-only header buttons;
      `pnpm test:e2e:ios` runs them. Needs the Maestro CLI + dev-client on
      a simulator with Metro running; gesture (drag) flows remain future
      work — Maestro can't synthesize long-press pans reliably.
- [x] Renderer error boundary + a log file — done: ErrorBoundary with a
      reload screen around the renderer root (errors forwarded to main via
      a `logError` preload channel); `userData/logs/main.log` with 1 MB
      rotation tees console.warn/error (where Effect's default logger
      writes) plus fatal process events and renderer errors.

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

## Project review (2026-08-28)

Ranked backlog from a full-project audit (docs drift was fixed in the
same PR; these are the code/infra improvements worth their own tasks).

1. [x] Surface mutation failures in the UI — done: `useGuardedMutations`
       (packages/app-state/src/mutationGuard.ts) wraps fire-and-forget
       mutations so failures publish a MutationNotice instead of
       vanishing as unhandled rejections; both apps render it as a toast
       (desktop App.tsx, iOS ui/Toast.tsx — also mounted inside the
       Settings modal, which covers the root toast). Editors with inline
       error UI keep using `useBackendMutations`.
2. [x] Transactional migrations — done: each migration + bookkeeping row
       commits in one `sql.withTransaction` (mid-failure rolls back to
       the last applied migration and retries next launch); duplicate-id
       and downgrade guards die loudly. Runner parameterized for tests
       (`runMigrationsWith`).
3. [x] PR-only unsigned `package:app` smoke job — done: `package-smoke`
       in ci.yml (macos-26, needs gate) packages unsigned and asserts the
       .app exists, the model helper landed in Resources, and none of
       helper/e2e/e2e-artifacts leaked into the bundle.
4. [ ] Dedup the findTime pipeline (`apps/desktop/renderer/ai/findTime.ts`
       and `apps/ios/src/findTime.ts` are byte-identical → move into
       `packages/ai`); extract a shared `useQuickAddModel` — QuickAddBar
       and CommandBar re-implement one state machine and have already
       diverged (MicrophoneDeniedError is handled in different phases →
       wrong copy on iOS).
5. [ ] Test the untested load-bearing pure code — `assembleWindow`
       (every rendered event flows through it; zero direct tests) and
       the editor models (~386 shared untested lines).
6. [ ] Harden the model IPC + helper supervision — validate/size-cap
       `model:*` inputs in main, kill the helper child on request
       timeout (a wedged process currently stays wedged), add a
       `will-navigate` guard + CSP to the renderer.
7. [ ] CI structure — extract the duplicated gate into a `workflow_call`
       reusable workflow (ci.yml + ios.yml run it twice per merge), pin
       third-party actions to SHAs, path-filter docs-only PRs, cache
       `helper/.build` (testing-build's 30-min budget is tight cold).
8. [ ] DB robustness — index `pending_ops (next_attempt_at, created_at)`
   - LIMIT in `listDue`; atomic temp-file+rename writes and an
     availability guard in the desktop safeStorage token store.
9. [ ] Derive the rpc plumbing — `BackendMethodName`, the direct client,
       and the handler layer are 5 hand-maintained parallel lists; derive
       them from the `AppBackendRpcs` group so adding a method is one
       edit.
10. [x] Housekeeping batch (the structural half) — done: mutations.ts
        split into mutationTypes/applyOp/taskMutations + a 644-line core;
        EventEditSheet split into shell + EventEditForm/TaskEditForm +
        editSheetShared; iOS ErrorBoundary + ConflictToast parity (a 412
        server-wins was silent data loss on iPhone).
11. [ ] Housekeeping leftovers — `packages/ai` errors →
        `Data.TaggedError`; unify editor labels; dedup the app-state LRU
        helpers; main-process `uncaughtException` should exit after
        logging; iOS `app.json` updates: set `checkAutomatically` + a
        fallback timeout.
