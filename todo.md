# TODO

## Follow-ups

- [x] App name — decided: **Solunivo** (no trademark hits, solunivo.com
      purchased; latent sol+luna+novo reading). Renamed product surfaces:
      packager name/executable, bundle ids (desktop com.solunivo.desktop,
      iOS com.solunivo.app), window/OAuth-page titles, sidebar brand,
      core appName, CI artifact + verify paths, docs. Internal @calendar/\*
      package scopes and the GitHub repo name intentionally kept. NOTE:
      the Google Cloud iOS OAuth client must be recreated for the new
      bundle id before iOS sign-in works again; packaged-app userData
      moves (Application Support/Solunivo) so testers re-auth.
- [ ] Real app icons (macOS .icns / Assets.car, iOS app icon set)
- [ ] Signing/notarization for the macOS app — CI `testing-build` job +
      `docs/distribution.md` are merged (signed+notarized arm64 zip artifact
      on every main push; decision: no universal build, artifact-only, no
      auto-update while the repo is private). Open until the six secrets
      from docs/distribution.md are added to repo settings and the first
      `testing-build` run goes green
- [x] EAS build / TestFlight distribution for the iOS app — done: EAS
      Build+Submit on every main push (fire-and-forget from ubuntu CI) plus
      per-PR OTA preview channels (pr-<n>, ~30s) with an in-app channel
      switcher (Settings → PR preview, expo-updates header override);
      `testflight` PR label ships a real build for native changes
      (fingerprint runtimeVersion keeps incompatible OTA updates away).
      Decisions: single bundle id (one install per device — platform
      constraint), no per-PR TestFlight builds by default (cost/latency).
      Open until Nik: first interactive build, EXPO_TOKEN secret, ASC
      internal testers. See docs/distribution.md. Note: the OAuth consent
      screen is in Testing, where refresh tokens expire after 7 days —
      publish to Production before adding outside testers, or they hit a
      weekly forced re-sign-in.
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

- [ ] Natural-language quick add — "lunch with Sarah tue 1pm at Figlmüller, monthly"
      → a prefilled editor to confirm (never an auto-save). Parser output maps onto
      the existing `buildEventTimes`/`validateEventDraft`/`buildRecurrenceRule`
      helpers, so it reuses the whole save path. iOS first (text + dictation);
      desktop follows via a ⌘K bar once the helper below exists. A local model also
      handles German phrasing ("nächsten Dienstag um halb drei"), which hand-written
      date grammars generally do not.
- [ ] Find a time — "90 min of focus this week, mornings" → ranked free slots. The
      model only parses the constraint sentence; a deterministic solver over
      `EventRepo.getWindow` + `assembleWindow` finds and ranks the gaps, so it is
      offline, pure and testable. Both platforms.
- [ ] Capture from text or photo — paste an email (desktop) or share a
      screenshot/poster (iOS share sheet, using image input) → extracted event(s).
- [ ] Voice capture — ships with quick add on iOS; reaches desktop with the helper
      binary, since macOS 26 exposes the same speech API. Siri/App Intent entry
      point later.
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
- [ ] Desktop model runtime (prerequisite for everything desktop-side) — one signed
      Swift helper exposing both Foundation Models and `SpeechAnalyzer` over stdio,
      versus bundling a GGUF. Note the nested-binary signing (`osxSign` runs with
      `continueOnError: false`, so an unsigned helper fails the build outright) and
      the extra CI step to build it.

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
- [ ] Sync Google Tasks — show tasks with due dates alongside events and
      let them be checked off. Feasible via the separate Google Tasks API
      (`tasks.googleapis.com`: task lists → tasks with `due`, `status`,
      `notes`; complete via `tasks.patch`). Needs the additional
      `auth/tasks` OAuth scope (re-consent), a local `tasks` table, and a
      poll using `updatedMin` (the Tasks API has no syncTokens). Rendered
      as chips in the all-day lane with a completion checkbox. Known API
      limits to design around: `due` is date-only (the time portion is
      discarded), and recurrence rules are NOT exposed — Google
      materializes the next occurrence of a repeating task server-side
      when the current one is completed, so repeating tasks "just work"
      but can't be expanded locally like event RRULEs.
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
      check + typecheck + unit tests) and an `e2e` job (macos-14:
      electron-rebuild, desktop build, CDP e2e suite) on pushes to main
      and PRs.
- [x] Electron auto-update — done: `update-electron-app` runs in packaged
      builds (GitHub releases, 1h interval) and the Forge GitHub publisher
      is configured (draft releases). Becomes fully active once the app is
      signed/notarized and releases are published (public repo or fed
      token); a no-op until then.
- [x] iOS e2e via Maestro — done: four flows in `apps/ios/e2e/flows/`
      (launch, view switching/navigation, new-event sheet incl. repeat
      picker, accounts sheet) with testIDs on the icon-only header buttons;
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
