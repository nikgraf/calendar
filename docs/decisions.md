# Decision log

Shipped work and the decisions taken with it, moved here from `todo.md`
(2026-09-10) so the backlog stays a backlog. Entries are verbatim from the
day they were closed; PR numbers where they were recorded. When a backlog
item lands, its `[x]` entry moves here under the matching area with the
design decisions it settled.

## Product and naming

- [x] App name — decided: **Solunivo** (no trademark hits, solunivo.com
      purchased; latent sol+luna+novo reading). Renamed product surfaces:
      packager name/executable, bundle ids (desktop com.solunivo.desktop,
      iOS com.solunivo.app), window/OAuth-page titles, sidebar brand,
      core appName, CI artifact + verify paths, docs. Internal @calendar/\*
      package scopes and the GitHub repo name intentionally kept. The
      Google Cloud iOS OAuth client was recreated for the new bundle id
      (#23); packaged-app userData moved (Application Support/Solunivo)
      so testers re-authed once.

## Distribution and infrastructure

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
      weekly forced re-sign-in — and Production requires Google's app
      verification for the sensitive `contacts.*` scopes.
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
      (Since grown to 12 flows; the list in `AGENTS.md` is the current one.)
- [x] Renderer error boundary + a log file — done: ErrorBoundary with a
      reload screen around the renderer root (errors forwarded to main via
      a `logError` preload channel); `userData/logs/main.log` with 1 MB
      rotation tees console.warn/error (where Effect's default logger
      writes) plus fatal process events and renderer errors.
- [x] PR-only unsigned `package:app` smoke job — done: `package-smoke`
      in ci.yml (macos-26, needs gate) packages unsigned and asserts the
      .app exists, the model helper landed in Resources, and none of
      helper/e2e/e2e-artifacts leaked into the bundle.
- [x] Real-EventKit e2e on CI, every PR + main, both required — done:
      `ios-e2e` runs Maestro against the EAS development-simulator
      build for the commit's fingerprint (cached in Actions; CI never
      runs xcodebuild) with `simctl privacy grant reminders`;
      `e2e-reminders` runs the helper against the runner's Reminders
      with a seeded TCC grant and a hard fullAccess probe. Decisions:
      hard failures, not skip-with-warning (a broken TCC seed must be
      seen); the strict flow/spec are CI-only siblings of the tolerant
      local ones. First catch: the helper's main thread sat in
      readLine(), so EKEventStoreChanged never fired — the desktop
      change push had never worked.

## Calendar: editing, gestures, views

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
- [x] Create recurring events — done: `buildRecurrenceRule` in core
      (freq + interval + end-after-count / end-on-date; RFC 5545 defaults
      keep the series on DTSTART's weekday/day-of-month), optional
      `recurrence` on `EventDraft`, repeat pickers in both editors
      (create mode). Custom BYDAY combinations stayed out of scope until
      the by-day repeat rules entry under Apple Reminders (2026-09-20).
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

## Invitees and contacts

- [x] Attendee add/remove — done: `attendees` (replacement list) on
      `EventDraft`/`UpdateEventChanges`, `mergeAttendees` in core keeps
      server facts for retained guests, `toGcalEventInput` emits the list
      (undefined = untouched, [] = clear), and every insert/patch of a
      record with attendees sends `sendUpdates=all` — decided: always
      notify, never ask. Organizer chip is not removable.
- [x] Invitation autocomplete from device contacts (macOS/iOS) — done
      via the Swift helper / an Expo module, not `node-mac-contacts` or
      `expo-contacts`: `packages/contacts` mirrors the reminders seam
      read-only (`contacts.status/requestAccess/snapshot`, one
      `ContactsBridge.swift` over CNContactStore symlinked into both
      hosts). The backend holds the snapshot in memory (`DeviceContacts`,
      refreshed on CNContactStoreDidChange and when stale) — nothing
      written to SQLite. Hardened runtime requires the Address Book
      entitlement on the app and helper even without App Sandbox;
      `NSContactsUsageDescription` in the helper's embedded plist,
      forge `extendInfo`, and app.json. Permission ask lives inline in the
      combobox (first focus) plus a Settings section; e2e runs with
      `CALENDAR_CONTACTS=off`, real-contacts stays untested in CI.
- [x] Invitation autocomplete from Google contacts — done: cached, not
      live. `GooglePeopleClient` lists saved contacts and "other
      contacts" with sync tokens (People reports expiry as 400
      `EXPIRED_SYNC_TOKEN`, folded into `SyncTokenExpiredError`); the
      engine keeps both tiers per account in a `contacts` table (one row
      per person × email, tier replaced atomically on full passes).
      `contactsEnabled` mirrors `tasksEnabled` — existing accounts
      re-consent via "Add Google Account"; the People API (not the
      retired Contacts API) must be enabled in the GCP project. One
      `searchContacts` rpc merges SQLite + device rows through
      `rankContacts` (prefix > substring, saved/device >
      other, dedupe by email) behind a hand-rolled combobox on both
      platforms (chips, ArrowUp/Down/Enter, comma/blur accept typed
      addresses, Backspace removes the last chip).
- [x] Show contact birthdays — done (2026-09-12): from the People API
      `birthdays` field (connections only) and `CNContactBirthdayKey`
      through the shared bridge (`contacts.birthdays`), merged per person
      by folded name + MM-DD so someone in both address books is one
      chip with two sources; the detail view is read-only and names each
      source with the account email. Decisions: People, not Google's
      read-only Birthdays calendar — that calendar is now skipped in
      `syncCalendarList` (it would show everything twice and carries no
      year); a person needs no email to have a birthday, so
      `contact_birthdays` is its own table under `BIRTHDAYS_KEY` (the
      typeahead never refetches on a birthday change); neutral chip with a
      fixed pink accent because birthdays have no calendar color; Feb 29
      renders on Feb 28 in common years; no cross-column spanning on the
      phone; month views followed on 2026-09-15 (entry below).
- [x] Birthday reminders — done (2026-09-12): a multi-select of lead
      days {0, 1, 3, 7, 14} plus one delivery time, stored in the new
      `device_settings` key/value table and shown as "stored only on this
      device" — the first preference that never syncs. Decisions: SQLite
      via rpc rather than a per-platform settings file (per-device and
      never uploaded; the consumer is a backend job in both hosts);
      `BirthdayReminders` runs its own 60 s loop outside the sync pass
      and narrows on a `NotificationSink` — desktop fires Electron
      notifications while running (24 h catch-up, fired keys remembered),
      iOS pre-schedules the next ≤ 60 through expo-notifications and only
      reschedules when the plan changed; per-person overrides deferred.
      Permission: iOS asks through expo-notifications on every enabled
      save; Electron has no authorization query, so desktop asks only as
      the reminders turn on, by posting a "Birthday reminders are on"
      banner — 'show' means granted, 'failed' means denied (inline notice
      in Settings), an unanswered prompt counts as granted after 60 s.

## Google Tasks

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
      (moving needs tasks.move) — superseded 2026-09-21 by the task
      move below (copy-then-delete, no `tasks.move` needed).
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

## Apple Reminders

- [x] Apple Reminders integration — done: personal reminders appear in
      the calendar alongside Google Tasks. Decisions: EventKit via the
      existing Swift helper on macOS and a local Expo module on iOS (one
      shared Swift source; expo-calendar rejected — no priority, no
      all-day/timed distinction); a synthetic `apple-reminders` account
      with provider-dispatched mutations (no pending-op queue — EventKit
      is local); per-provider forms (Google: title/day/notes/fixed list;
      Reminders: time, priority, alert, repeat, URL, movable list). Date-only
      reminders render in the all-day lane; timed reminders now render as
      compact, draggable blocks in the time grid. See
      docs/architecture.md + docs/google-sync-and-testing.md.
      Google Tasks still make sense when working with Gmail.
- [x] Complete mirror + EKEventStoreChanged push — done: no date
      window (paging 1.5 years ahead reads locally, like Google Tasks);
      id-list + delta protocol keeps the bridge payload proportional to
      change; transactional snapshot reconciliation (newer wins,
      stamp-guarded removal, no giant NOT IN); the notification is
      latency, the 90 s pass is correctness.
- [x] Review round 2 fixes — done: Save sends only dirty fields
      (diffed against the opening snapshot, both providers); a mirror
      write failing after EventKit committed is logged, not raised (a
      retry would duplicate); mirror INSERTs are guarded on the account
      row so removal cannot be undone by an in-flight pass (Google had
      the same race); Gregorian wire dates; `boundedInt` before every
      native conversion; read-only lists carried as
      `TaskListInfo.readOnly` and opened as viewers. Decision: EventKit
      enforces read-only — no mutation-layer error, the rare slip
      surfaces as saveFailed.
- [x] Timed-reminder grid review fixes (#73 follow-up) — done: the day
      column is a fixed 24-hour wall clock, so `layoutDayColumn` places
      every box — events, reminders, the "now" line — by wall-clock minute
      instead of elapsed time; on a DST day an event sits beside its hour
      label (spring-forward 01:30–03:30 draws two rows tall, the repeated
      fall-back hour overlaps, as in Google Calendar). Reminders never go
      through a time zone: their due date/time are EventKit date
      components, so a time inside the spring-forward gap is kept as
      stored and drawn at its label. A reminder drag starts from where the
      block is drawn (a 23:50 reminder sits at 23:30 to stay on its day),
      so it lands where it was dropped; a day-only move keeps the stored
      time. The drag's click suppressor is cleared by the next
      `pointerdown`: a suppressed click belongs to the gesture that set
      it, so a cancelled pointer that never delivers its click cannot
      swallow the user's next one.

- [x] By-day repeat rules — done (2026-09-20): weekly rules name their
      weekdays ("Weekends", "every Tue and Thu") and monthly rules may
      name one "Nth weekday" (1st…4th or last), for Apple Reminders and
      for events (Google via RRULE BYDAY, Apple Calendar via the
      structured rule it already carried), in both editors on both
      platforms. Nik's pick over weekly-only and reminders-only after his
      "Weekends" reminder opened as "cannot edit". Decisions: one `ByDay`
      type (`packages/core/src/recurrence/byDay.ts`) shared by the
      structured rule, `TaskRecurrence` and the editor spec, with
      `byDayError` stating the allowed shapes once for the editors and the
      Swift write path (and again in the reminder mutations, so the fake
      and the real bridge agree); the wire stays minimal — a weekly rule
      sends its weekdays only once they are explicit (the source rule named
      them, or the user toggled one), so scalar fixtures stay scalar, an
      untouched Save never rewrites a rule Reminders.app stored explicitly,
      and moving the date of an untouched rule never pins it to the weekday
      it started on; the shared repeat state (`useRepeatState`) takes the
      anchor date, shows its weekday and ordinal until the user picks, and
      is pure underneath (`seedRepeatFields`, `repeatSpecFrom`, tested);
      the last selected weekday cannot be removed; a monthly rule on a
      plain weekday without an ordinal stays unsupported (Reminders.app
      cannot create one; rewriting it as weekly would be a silent change);
      the Reminders bridge reads a monthly ordinal whether
      EventKit stored it as the day's week number or as a set position
      and writes it as the week number; yearly positional rules, several
      rules and day-of-month lists still round-trip as `recurrenceUnsupported`.
      Repeat controls live in one component per platform
      (`RepeatRuleFields`, `RepeatRuleChips`), which also gave the reminder
      form its aria-labels and Maestro-assertable chip selection; labels
      use Reminders.app's words ("Weekly on weekends", "Monthly on the 2nd
      Tuesday"). The Swift change moves the iOS fingerprint: a
      development-simulator build was queued for CI and the merge triggers
      TestFlight. The strict Maestro flow exercises the monthly path (its
      chips set rather than toggle, so it holds on any date); the
      real-helper desktop suite round-trips both rule kinds.

- [x] Convert a Reminder ↔ Google Task — done (2026-09-21): the task
      editor's list picker offers every writable list of every account,
      grouped per account like the event editor's calendar picker, and
      picking a list elsewhere moves the task on Save. Decisions: one
      `moveTask` rpc mirroring `moveEvent` — Apple → Apple stays
      EventKit's in-place list change (identifier kept); every other
      route, Google → Google across lists or accounts included, creates
      the task in the target and then deletes the source, so a failure in
      between leaves a duplicate, never a lost task (Apple → Google:
      queue the create in a transaction, then EventKit delete; Google →
      Apple: EventKit create, then queue the delete; Google → Google: both
      queue writes in one transaction). Unlike an event move the rpc
      carries the _draft_: the editor flips to the target provider's form
      the moment a list in the other provider is picked, so a Google task
      can get a due time or priority on its way into Reminders, and the
      form's values — not the source row — are what gets written.
      Completion follows the task (a `completeTask` op queued behind the
      create on the temp id, or `setCompleted` on the new reminder). The
      loss preview is pure core (`taskMoveLoss` on the source record: due
      time, alerts, priority, repeat rule incl. `recurrenceUnsupported`,
      URL — only Apple → Google drops anything; the Google web link is
      not carried, it points at the task being deleted) so no preview
      rpc exists; the same `confirmMove` seam as events asks before
      anything is written. Google → Google is not a server move: the
      task gets a new id and `parent`/`position` (unmodeled) do not
      follow. Read-only Reminders lists are never offered as a target.
      Desktop e2e (`taskConvert.e2e.ts`) seeds a Google account beside the
      Reminders fixture for the first time. Follow-up in the same PR: the
      in-process fake Google API (`testing/fakeGoogle.ts`) became an app
      fixture (`testing/googleFixture.ts`; desktop `CALENDAR_GOOGLE=fixture`,
      iOS `EXPO_PUBLIC_CALENDAR_GOOGLE=fixture`, on for the whole CI Maestro
      batch), so `taskConvertGoogle.e2e.ts` and `16-task-convert.yaml`
      watch the queued create push and the temp id become a server id —
      and the Google halves of iOS flows 07/08 run for the first time.
      Decided: no HTTP mock server; the fake sits behind effect's
      HttpClient and a pre-filled memory TokenStore keeps the real
      TokenManager and request core on the path.

## Apple Calendar

- [x] Apple Calendar calendars + events, and moving events between
      calendars — done: the device's Calendar app calendars (every
      EventKit source: iCloud, Exchange, On My Mac, subscribed) appear
      next to Google, with create/update/delete, and an event can move
      Google↔Google, Google↔Apple and Apple↔Apple. Decisions: a third
      EventKit seam (`packages/apple-calendar`, one Swift source for the
      helper and an Expo module) under one synthetic `apple-calendar`
      account; skip the Birthdays calendar and sources named like a
      connected Google account; calendars mirrored, **events read
      through** (no local rows, no window, EventKit expands series — Nik
      wanted neither a rolling window nor drift from Calendar.app, and the
      backend rpc stays the one query surface for a future CLI/agent);
      EventKit-first writes with scopes mapped to spans; guests/RSVP are
      Google-only (hidden, and rejected by the mutation layer); moves take
      the whole series — a server `events.move` inside one Google account,
      EventKit's own calendar change between Apple calendars, otherwise
      copy-then-delete that drops guests and modified occurrences **after
      a confirmation** (`previewMove` → `moveLossSummary`); a move and the
      edits of its series keep queue order even through backoff
      (`earlierInSeries`, rowid tiebreak). Open: the two _(verify)_ items
      in docs/google-sync-and-testing.md.

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

## Robustness

- [x] Surface failed/pending ops — done: reactive `OPS_KEY` on the op
      queue, `listPendingOps`/`discardPendingOp` rpcs, "N unsynced changes"
      panel in the desktop sidebar and iOS settings (per-op discard, retry
      count). 412 server-wins now broadcasts `notice:conflict` over the
      invalidation stream and the desktop shows a toast. (Superseded
      2026-09-23: a 412 parks the op — see "Conflicts with a choice".)
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

## Architecture

- [x] Migrate UI state/data flow to `@effect/atom-react` — done: atoms
      subscribe to fine-grained Reactivity keys (`accounts`/`calendars`/
      `events`); backend invalidations flow through a forwarding bridge
- [x] Replace the hand-rolled Schema-typed IPC bridge with
      `effect/unstable/rpc` — done: `AppBackendRpcs` RpcGroup in core,
      custom duplex protocols over the Electron IPC frame channel
      (`packages/sync/src/rpcDuplex.ts`; a MessagePort transport is a
      drop-in duplex swap), and the invalidation stream is a typed
      `stream: true` rpc

### Project review (2026-08-28), closed items

- [x] Surface mutation failures in the UI — done: `useGuardedMutations`
      (packages/app-state/src/mutationGuard.ts) wraps fire-and-forget
      mutations so failures publish a MutationNotice instead of
      vanishing as unhandled rejections; both apps render it as a toast
      (desktop App.tsx, iOS ui/Toast.tsx — also mounted inside the
      Settings modal, which covers the root toast). Editors with inline
      error UI keep using `useBackendMutations`.
- [x] Transactional migrations — done: each migration + bookkeeping row
      commits in one `sql.withTransaction` (mid-failure rolls back to
      the last applied migration and retries next launch); duplicate-id
      and downgrade guards die loudly. Runner parameterized for tests
      (`runMigrationsWith`).
- [x] Dedup the findTime pipeline + quick-add state machine — done:
      and `apps/ios/src/findTime.ts` are byte-identical → move into
      `packages/ai`); extract a shared `useQuickAddModel` — QuickAddBar
      and CommandBar re-implement one state machine and have already
      diverged (MicrophoneDeniedError is handled in different phases →
      wrong copy on iOS).
- [x] Derive the rpc plumbing — done: `BackendMethodName` is
      `Exclude<RpcGroup.Rpcs<…>['_tag'], 'invalidations'>`,
      `backendMethodNames` reads the group's runtime request map, and the
      direct client / handler layer / mutation atoms are built from it
      (atoms from a single `MUTATION_REACTIVITY` keys map). Adding a
      method = the Rpc.make, its handler, and a keys entry — everything
      else follows or type-errors.
- [x] Housekeeping batch (the structural half) — done: mutations.ts
      split into mutationTypes/applyOp/taskMutations + a 644-line core;
      EventEditSheet split into shell + EventEditForm/TaskEditForm +
      editSheetShared; iOS ErrorBoundary + ConflictToast parity (a 412
      server-wins was silent data loss on iPhone).

### Project review (2026-09-10), closed items

- [x] Recurring overrides scoped to their master's account and calendar —
      done: `EventRepo.getWindow` joins the master row on (account,
      calendar, id) and the calendar on visibility for its override query;
      `assembleWindow` keys shadowing by account + calendar + master id.
      Event ids are Google-global, so two accounts on one shared calendar
      carried same-id masters and one account's exception hid the other's
      occurrence. First direct tests for `assembleWindow`.
- [x] Dispatched task creates stay intact under edits — done: an edit
      folds into a createTask only while it is undispatched (fresh attempt
      counters); behind a dispatched create it queues as an updateTask, so
      the retry's exact-field adopt check still matches and never inserts
      twice. Decision: task ops still carrying a temp `local-` id wait in
      applyOp until the create swaps it — a follower that ran first patched
      the temp id and the 404 dropped the local row.
- [x] WeekView builds its timed-event lookup once per render (was once per
      column, on every drag pointermove).
- [x] iOS all-day event chips open the editor (were a plain View; task
      chips beside them were pressable). VoiceOver label + testID, Maestro
      flow 12.

### Backlog sweep (2026-09-11), closed items

One PR (`todo/backlog-tiers`), one commit per item, tiers 1–6 of the
2026-09-10 backlog minus PR videos and app icons.

Correctness and the sync path:

- [x] Permanent rejections are announced — done: a non-409 4xx drops the
      op _and_ broadcasts `notice:dropped` (DroppedToast on both apps);
      `markFailed` stores the real reason (`describeFailure`) so the
      unsynced-changes list can show it; `processPendingOps` logs the
      squashed cause instead of swallowing it. `InsufficientScopeError`
      disables tasks only for task ops. A permanently rejected createTask
      also removes its optimistic `local-` row.
- [x] Tolerant row decoders — done: `pendingOpFromRow` returns `undefined`
      for a payload that no longer decodes and the queue skips it (logged),
      instead of throwing out of `listAll()` on every mutation. Enum
      columns go through `oneOf` guards, not bare `as` casts. Decision: no
      payload version tag — the schema is the tag; a row that fails it is
      quarantined by being ignored, and the Discard UI still lists it.
- [x] Pulls skip rows with a queued local edit — done: `upsertMany` /
      `upsertTasks` take `{ mode: 'pull' }` and leave `pending` rows alone;
      `setStatus`/`updateLocal` now mark tasks pending (the docs had claimed
      it); an abandoned op hands its row back via `releaseRow`
      (`markSynced`, or delete for a create). Documented in architecture.md.
- [x] Local write and queue change commit in one transaction — done:
      every coalesce-then-enqueue path runs inside `sql.withTransaction`
      with the drain kicked after commit (`transactional` helper); a
      rollback test drops `pending_ops` mid-mutation. Decision: the kick is
      `Effect.suspend(forkDetach)` so a failed transaction never starts a
      drain; the color test is pinned with `noYield` (see
      docs/google-sync-and-testing.md).
- [x] `truncateRecurrence` prunes RDATE — done: a this-and-following split
      drops RDATE values at or after the split (`parseDateList`,
      `listValueMs`), honouring the series time zone for floating values.
- [x] Malformed timestamps degrade the row, not the pass — done:
      `instantMs`/`plainDateMs` return `undefined` and the mapper skips
      the row with a warning; the calendar's pass completes.
- [x] Desktop token store — done: temp-file + rename writes,
      `isEncryptionAvailable()` guard with a typed failure, an in-memory
      cache so authed requests stop hitting file + Keychain, one
      serialized read-modify-write. `makeEncryptedTokenStore(deps)` is unit
      tested with a fake safeStorage.
- [x] Indexes and bounds — done: migration 10 adds the `pending_ops`
      drain index, `tasks(due_date)` and an events window index that leads
      with the range; `listDue` pages at 200. (The masters query got its
      lower bound only with the full-history work below — this entry
      claimed it too early.) `CREATE INDEX IF NOT EXISTS` because the
      migration test re-runs against a seeded schema.
- [x] Sync-loop nits — done in one commit: per-account `catchCause` in
      `syncRemindersOnly`; the second full pass re-checks `skipped`;
      `Retry-After` is honoured by the transient retry loop; every error
      branch drains `response.json`; `DeviceContacts.list()` is
      single-flighted and a failed snapshot retries after `FAILURE_RETRY_MS`
      instead of caching `[]`; migrations enforce monotonic ids; an
      undecodable 2xx drops the op instead of retrying forever.
- [x] Electron hardening — done: a CSP via `onHeadersReceived` outside
      dev, `will-navigate` + `setWindowOpenHandler` allow-lists on every
      web-contents, `model:*` payloads validated and bounded, the helper is
      killed on request timeout, `renderer-error` is capped, settings are
      written atomically.
- [x] Adapter drift — done: `finishAddAccount`, `makeSyncKicker`, the
      bridge client factories (`remindersClientFrom`/`contactsClientFrom` + layers, `helperTransport(killSwitch)`) live in the packages;
      `changesFromSubscription`/`bridgeMessage` moved to
      `@calendar/core/bridge`. iOS gets no `CALENDAR_*=off` switch — its
      e2e runs against the real bridges by design (flow 10).

Cost, CI and distribution:

- [x] Docs-only changes skip the macOS jobs — done: a `changes` job
      classifies the push via the GitHub compare API and the macOS jobs
      carry `if:` guards (not `paths-ignore`, which would leave required
      checks unreported).
- [x] One reusable gate — done: `gate.yml` (`workflow_call`) replaces the
      duplicated steps in ci.yml and ios.yml. The check is now named
      "Gate / Lint, typecheck, unit tests" — branch protection must be
      pointed at it.
- [x] Caches — done: `apps/desktop/helper/.build`, the Electron binary and
      `~/.maestro` are cached; the hoisted `node_modules` link phase is
      left alone (pnpm's store cache already covers the download).
- [x] Supply chain — done: Maestro pinned to 2.10.0 with a sha256,
      `EXPO_TOKEN` scoped to the steps that need it, `pnpm/action-setup`
      SHA-pinned, `dependabot.yml` for actions and npm.
- [x] Flake budget — done: `retry: 1` on the desktop e2e specs.
- [x] Distribution — done: the testing build embeds the RFC 8252 desktop
      OAuth client from a secret-fed `google-oauth.json`; versions start
      at 0.1.0 on both platforms with a CHANGELOG. Crash reporting stays
      off (privacy posture); auto-update remains blocked on the private repo.

Developer workflow and tests:

- [x] Tests for untested pure code — done: all-day lane packing, the
      Google API schemas' tolerance, the Tasks client, the device contacts
      cache, the token store, `assembleWindow`, row decoders.
- [x] A fake Google server — done: `packages/sync/src/testing/fakeGoogle.ts`
      behind `HttpClient.make` replays calendar/events/tasks fixtures with
      410 sync-token expiry, tombstones, watermarks and 412; `engine.http.test.ts`
      drives the real poll/push/pull loop through it. Engine tests must
      `TestClock.adjust` between passes.
- [x] Hooks and scripts — done: `vp config` installs a pre-commit hook
      that runs `vp staged` (`vp check --fix` on staged files);
      `test:run`, root `lint`, incremental typecheck, root `test:e2e` runs
      the helper guard first. Note: the hook commits the whole index, so
      split commits by staging deliberately.
- [x] Guards for manual steps — done: `check-helper.mjs` (desktop e2e
      against a stale/absent helper) and `check-devclient.mjs` (installed
      dev client fingerprint ≠ working tree) warn before the suites run;
      README notes the JDK for Maestro.
- [x] Housekeeping leftovers — done: `packages/ai` errors are
      `Data.TaggedError`s, one `boundedAtomCache`, `uncaughtException`
      exits after logging, `app.json` updates get `checkAutomatically` +
      a fallback timeout (changes the native fingerprint), a checked month
      grid, `@types/react` from the catalog.

Parity, UX and accessibility:

- [x] Desktop keyboard and dialogs — done: one `Dialog` (role, focus trap
      and restore, Escape via a window capture listener, backdrop close
      button) wraps the editor, settings and ⌘K; shortcuts ⌘K, ⌘,, ⌘N, T,
      ←/→; day columns and event blocks are focusable buttons. The
      settings button keeps `title="Accounts"` — the e2e suite finds it by
      that.
- [x] iOS VoiceOver — done: labels on the icon-only header buttons,
      selected state on the segment, labelled WeekStrip/MonthGrid cells.
- [x] Quick-add divergence — done: `useModelAvailability` (re-check on
      window focus / AppState active, Retry) shared by both bars; the
      desktop CommandBar resolves relative dates against the viewed day.
- [x] Invitee field parity — done: `useInviteeField` owns the debounce,
      arrow/comma/Backspace handling and stale dimming; InviteeCombobox and
      the iOS InviteeField are thin views over it.
- [x] Shared-code moves — done: editor option labels, `pendingOpLabel`,
      permission-status copy, `useCalendarNavigation`, `formatClockTime`/
      `formatSlotLabel`, `useListColorLookup` live once in app-state/core.
- [x] Add flow picks the right calendar — done: the editor seeds from
      `calendarKey` when given and otherwise defaults to the last-used
      calendar (module-level, remembered on save).
- [x] iOS parity — done: a Week view (the timeline renders `days` visible
      columns with a `WEEK_SWIPE_BUFFER` of seven so a swipe pages by whole
      weeks; the week strip is the column header and tapping a day drops
      into Day), an "N unsynced" header badge that opens Settings, an
      all-day lane that grows to three rows with "+N more" (chips stack one
      per row), permission copy shared with desktop, and the ErrorBoundary
      writes the last render error to the documents directory for
      Diagnostics to show and clear. Decision: no cross-column spanning of
      multi-day all-day events on the phone — each column lists its own
      day, which the per-column paging strip makes the honest choice.
- [x] Splits — done: one repo file per table under `packages/db/src`
      (`repos.ts` only assembles the layer), SettingsSheet → AccountCard +
      PrPreviewSection + DiagnosticsSection, DayTimeline →
      DraggableEventBlock + DayColumn + AllDayColumn, WeekView →
      DayHeaders + AllDayLane + TimedEventBlock, EventEditor →
      EventEditorForm.

Performance:

- [x] Drag, clock and hour lines — done: `useEventDrag` keeps only "which
      block, which mode" in state and publishes offsets through an external
      store; the dragged block alone subscribes (`useSyncExternalStore`),
      so a pointermove re-renders one block. `NowIndicator` owns the minute
      tick on both platforms. Desktop hour lines are one
      `repeating-linear-gradient` per column.
- [x] Month grouping — done: `groupEventsByDay` buckets a window's events
      per ISO day in one pass; both month views and the iOS timeline read
      from it.
- [x] Atom fan-out — done: `eventsInRange` watches `EVENTS_KEY` only and
      `tasksInRange` `TASKS_KEY` only; the repos invalidate those keys from
      the operations that change a window's contents (calendar visibility
      and removal). `useBackendMutations` builds its promise setters once
      per registry (`registry.set` + `AtomRegistry.getResult`) instead of
      nineteen `useAtomSet` mounts per consumer.

### Full event history (2026-09-14)

- [x] Events: the 12-months-back floor — done: the events pass sends no
      `timeMin`; a full list (first sync, 410 resync) fetches every event
      ever and the token then covers all of them; nothing prunes by age.
      Decisions: one unbounded first pass rather than a quick window plus
      a background backfill — Nik chose the simpler shape (pages land
      progressively, the Settings line explains the wait); migration 12
      clears every stored events token because a windowed token cannot be
      widened; each 2,500-event page is one transaction and one
      invalidation; `recurrence_end_utc` (UNTIL, or the last COUNT
      occurrence computed once at write time) bounds the masters query
      over a partial index; expansion has an iteration cap and a skipped
      master no longer blanks the window; calendars that vanish take their
      rows and their sync_state row with them (a calendar that comes back
      lists its history again); `listSyncStatus` shows "Importing history…
      N events so far" / "History complete" per account, only for
      calendars that still exist and accounts that can sync. Rode along:
      the event INSERT had never written `hangout_link`, so meeting links
      from Google were never persisted — fixed in the same statement.
      Follow-ups: series with RDATE lines stay unbounded, long-lived COUNT
      series still iterate from DTSTART on every read, no per-calendar
      history opt-out.

### Dependency sweep (2026-09-14)

- [x] Upgrade every dependency to the latest version the platform accepts
      — done (one commit per group, each droppable): vite-plus 0.3.1 with
      vitest 4.1.11 (the workspace overrides vitest to the catalog, so it
      must equal the version vite-plus bundles — vitest 5 is off the table
      until vite-plus moves), tsdown 0.23, plugin-react 6.1.1,
      oxlint-config 2 (its React Compiler immutability rule is disabled
      in the one file that writes Reanimated shared values); TypeScript
      7.0.2 (nothing in tsconfig needed to change); Electron 44, eas-cli
      24; the SDK 57 patch set for iOS with react-native 0.86.3,
      reanimated 4.5.1, worklets 0.10.1 and op-sqlite 17.2.0 (the
      @effect/sql-sqlite-react-native peer range is >=17.1.2 <18);
      rrule-temporal 2.2.5 with the app's Temporal namespace passed via
      its `temporal` option; Effect rc.115 (custom rpc protocols expose
      `codecFor`); the GitHub Actions majors; pnpm 12. Ceilings kept for
      the next sweep: react 19.2 (RN 0.86's renderer), gesture-handler
      2.32 / reanimated 4.5 / worklets 0.10 / react-native 0.86 /
      datetimepicker 9.1 (what Expo SDK 57 bundles; the oracle is
      `npx expo install --check`), op-sqlite < 18, vitest = vite-plus's.
      Expo still lists react 19.2.3 exact and typescript ~6.0.3 as
      "expected"; both are advisory and everything builds.

### Schema baseline (2026-09-15)

- [x] Collapse the twelve SQLite migrations into one — done: nothing had
      shipped, so the upgrade paths between them served nobody; one
      migration now creates the final schema and the one-off data fixes
      (token reset, orphan deletes) are gone with the history they fixed.
      Decisions: the runner keeps its "ahead of this build" guard rather
      than gaining a self-wipe — a pre-baseline database refuses to open,
      and the message names the reset; `pnpm reset:local`
      (`scripts/reset-local-data.sh`) wipes every local store on a Mac
      (both desktop builds, keychain keys, Squirrel caches, booted
      simulators) and TestFlight testers delete + reinstall once, noted in
      `docs/distribution.md`. From here on, schema changes are appended
      migrations again — the collapse is a one-time pre-release cleanup,
      not a policy.

### Tasks and birthdays in the month views (2026-09-15)

- [x] Tasks (and birthdays) in month view — done: both month views now
      receive the tasks and birthday occurrences their hooks were already
      fetching for the grid (`monthGridRange` and the fetch range share
      one `buildMonthGrid`). Decisions: each platform keeps its month
      idiom — desktop draws chips (task: checkbox glyph, the Reminders
      list accent where the lane draws one, struck through when done;
      birthday: pink accent, `data-birthday`) under the existing
      three-chip cap and "+N more", iOS draws dots (an outlined ring per
      task in the list color or grey, pink per birthday) under the
      four-dot cap; both cells carry the same accessible name from
      `monthCellLabel` ("Tuesday, September 15, 2 events, 1 task"); items
      are read-only summaries and the cell still opens the day, so no
      nested buttons on desktop and no new gestures on iOS; cells list the
      day's events first, then birthdays, then tasks — events keep the cap
      because they carry the calendar's color and a day full of tasks must
      not hide them (the review caught tasks-first doing exactly that);
      `groupByDate` in core replaces the iOS lane's two hand-rolled maps
      and feeds both month views. Desktop e2e asserts the seeded task
      through today's cell label (the day's seeded events push its chip
      into "+N more") and the birthday chip inside
      `[data-testid="month-grid"]`, and
      the seeded task is due on the local date (the UTC date is yesterday
      between local and UTC midnight); iOS has no seed path, the
      navigation flow stays as is.

### App icons and brand kit (2026-09-16)

- [x] Real app icons and logo design — done (#67): the selected "24"
      identity ships as the macOS icon (`apps/desktop/assets/icon.icns`,
      Forge `packagerConfig.icon`) and the iOS icon
      (`apps/ios/assets/icon.png`, `expo.ios.icon`), with a versioned kit in
      `brand/` (SVG masters, outlined logos, Inter fonts under the OFL,
      `tokens.json`, a preview) — usage rules in `brand/README.md`.
      Decisions: the SVG masters are the source and every raster is
      generated by `pnpm brand:build` (macOS only, it needs `iconutil`);
      the iOS export fills an opaque square and lets iOS apply its mask,
      while macOS keeps the folded silhouette on a transparent canvas; the
      iOS adapter fails loudly if the master's named shapes change, so a
      new master needs an explicit look at the platform conversion; the
      UI palette and the dark icon stay proposals, not applied to the app.
      Follow-ups: `pnpm brand:check` runs in the packaging smoke job (the
      one macOS job on every code PR), so a master or token edited without
      a rebuild fails CI; the published kit folder is replaced on rebuild
      instead of merged (renamed or removed exports used to survive
      there). An icon change alters the native fingerprint, so it reaches
      testers only through a TestFlight build, never an OTA update.

### Soft ivory identity (2026-09-17)

- [x] Adopt the A1 soft ivory study across the brand kit and native icons.
      Decisions: lighten the paper toward white (`#FFFAEC`), keeping the
      mint fold, blush backing and original Inter Bold 24 placement and
      size. The centered, smaller numeral study was not selected. Keep
      the 115% horizontal lockup ratio. Update the flat icon, reversed
      wordmarks, proposed dark icon's ivory numerals, palette and guide
      to the same soft ivory; native dark switching remains a proposal.

### Drag to create on the time grid (2026-09-16)

- [x] Draw a new event's slot on the week/day grid — done. Decisions:
      desktop draws with a press-and-drag on empty grid space, and a plain
      click below the 4 px threshold keeps opening the clicked hour; iOS
      keeps a plain drag for scrolling and swiping, so creating needs a
      300 ms hold on empty space, after which a one-hour slot appears and
      dragging while holding stretches it (Apple Calendar's hold default,
      stretched instead of moved, by Nik's choice); the hold slot is
      anchored where the finger touched down (not where it rests after the
      hold), only grows — past the hour's end, or a full quarter above the
      touch-down point — and the release creates exactly the slot shown,
      because a phone minute is about one point and fingers drift (the
      review of #69 found holds near a quarter line opening 30-minute or
      shifted slots); desktop counts only vertical travel toward the drag
      threshold (a sideways-drifting trackpad click stays the hour click)
      and drops a drag whose column left the page mid-drag; both snap to 15
      minutes like the event drag and stay in the column the gesture
      started in; the quarter the gesture started in always stays part of
      the slot, so dragging up from 23:05 by an hour opens 22:00–23:15; a
      slot reaching midnight ends at 23:59, because the editor is same-day
      and rejects 24:00; a gesture that starts on an event keeps moving it
      (desktop blocks stop propagation, iOS blocks sit above the column's
      gesture layer); flipping the form to Task keeps the slot's start as
      the due time, which only a Reminders list stores. Desktop e2e covers
      dragging down, dragging up, Escape and "a drag on an event draws
      nothing"; iOS has no Maestro flow because Maestro cannot hold and
      then drag, so the check there is the exported bundle workletizing the
      gesture callbacks plus a manual run. Out of scope: auto-scroll at the
      grid's edges, slots across days, keyboard slot selection.

### Event locations with maps (2026-09-19)

- [x] Structured locations and a map in the event editor — done.
      Decisions: Google's `location` is free text and stays the source of
      truth (no place ids exist in the API); coordinates are derived
      on-device with MapKit only — no API keys, no third-party geocoder,
      and no location permission (only CLLocationManager prompts, and it
      is never used). One PR ships the typeahead picker, geocoding and the
      map on both platforms. Coordinates are mirrored into the event's
      private extendedProperties with the source text, so other devices
      skip the lookup and an edit elsewhere visibly invalidates them.
      Review of #77 tightened two rules: only coordinates the user
      vouched for (a pick, or the event's own) are pushed — the lookup
      the editor runs for free text on open is device-local, so MapKit's
      guess for "Room 4B" never becomes every device's truth — and the
      null-deleting PATCH is sent only by the edit that dropped the
      coordinates (`PendingOp.geoCleared`), never on unrelated edits,
      since null-for-absent-key was only verified against the fake.
      Nik then asked for cache hits to expire: places open, move and
      close, so a hit older than 14 days is shown at once and refreshed
      in the background (stale-while-revalidate; a place in constant use
      refreshes on the same cadence because every refresh restamps it),
      and Settings on both platforms has "Clear location cache". Misses
      retry after 3 days (Nik's pick over the first 7/30: nothing in
      Apple's guidance names a number; both stay far from the geocoder's
      rate limit).
      The desktop map is a static `MKMapSnapshotter` image from the Swift
      helper (native look, no MapKit JS token or tile policy); iOS uses
      `expo-maps`. The desktop image is light-only until the renderer has
      a dark theme (the protocol already takes an appearance). Free-text
      lookups can land on a wrong place for nonsense text — accepted: the
      map shows what was found, and the picker gives exact results. The
      desktop helper's main loop moved from `dispatchMain()` to
      `RunLoop.main.run()`, which MKLocalSearchCompleter requires.
      Desktop e2e covers pick → map → queued coordinates, stored
      coordinates without a lookup, and meeting links; the iOS Maestro
      flow is local-only because it needs MapKit's network. Out of
      scope: location-based reminder alarms, `eventType` /
      `workingLocationProperties`, travel time.

### Task lane polish (2026-09-20)

- [x] Overdue tasks and reminders surface on today — done: an open
      task whose due day has passed shows only in today's all-day
      section (week, day and month, both apps) with a red text-presentation
      `⚠︎` and "Overdue · due <date>" in the tooltip/label; a timed
      overdue reminder becomes an all-day chip there. Decisions: on today
      only, never also on its original day (Nik's pick over showing both —
      no duplicates, one chip to complete or drag); a dedicated
      `getOverdueTasks({ before })` rpc (visible lists, `needsAction`, no
      cap — the collapsible lane handles a backlog) merged with the range
      query in `partitionCalendarTasks(tasks, today)`, which de-duplicates
      by key and never re-dates a record (every mutation still compares
      against the stored `dueDate`); `useToday` re-reads the date once at
      local midnight rather than ticking every minute.
- [x] Repeat marker on task chips — done: `↻` after the title on lane
      chips, timed blocks and month chips whenever `recurrence` or
      `recurrenceUnsupported` is set, "repeats" in accessibility labels.
      Google tasks carry no rule on the wire, so nothing shows for them.
- [x] Drag tasks between the all-day lane and the time grid — done on
      both platforms. Decisions: the drop is judged by where the pointer
      is released (`dropTargetAt` over the lane, grid viewport and scroll
      offset; a worklet, so iOS judges it on the UI thread) and the rules
      live in one pure function, `dropTaskChanges`: a grid drop sets the
      day and 15-minute time, a lane drop clears the time (also for an
      overdue timed reminder dragged along the lane it is drawn in), a
      lane drop on another day moves the day for both providers, and a
      Google task dropped into the grid is reported `unsupported` — the
      chip snaps back and a notice says Google Tasks are date-only, never
      a silent day-only move (the mutation layer's
      `UnsupportedForProviderError` stays as the second line of defence).
      Overdue chips drag by absolute target day, since their chip sits on
      today while `dueDate` is past. Desktop keeps the timed block's live
      translation for grid-to-grid moves (the existing e2e asserts it) and
      adds drop indicators for lane-origin and lane-target drags; iOS
      hosts a ghost at the timeline level because the lane and the
      ScrollView are different containers, so the timed reminder drag
      moved from "block follows the finger vertically" to ghost +
      indicator (event blocks unchanged). All-day event chips stay fixed.
      No auto-scroll at the grid edge. Desktop e2e covers every drop
      kind, the Google refusal (rows and op queue unchanged, toast text)
      and a read-only list; iOS has no Maestro flow (hold-then-drag).
- [x] Collapsible all-day lane, persisted — done: default expanded on
      both platforms (iOS previously defaulted to its 3-row cap);
      collapsed caps at 3 rows with "+N more" per overflowing column
      (`capAllDayLane`: a multi-day chip counts in every column it covers,
      the cap row of an overflowing column gives way to the "+N more"
      chip, a lane that fits changes nothing); "less" sits beside the
      `all-day` gutter label. The choice is a device setting — the first
      entry of a typed `ViewPreferences` struct
      (`getViewPreferences`/`setViewPreferences`) rather than per-boolean
      or untyped rpcs — and never syncs.
- [x] iOS week view pages day by day — done: the seven-column strip
      follows the finger 1:1 across its drawn buffer, and a release
      commits the columns crossed (whole columns plus the existing
      flick/quarter rule on the remainder, `swipeCommitColumns`, clamped
      to the buffer); the day view is the same code with one column. The
      week's day headers moved inside the timeline so they pan in
      lockstep, and tapping one opens that day; the day view keeps the
      Monday-week strip as its picker. `WEEK_SWIPE_BUFFER` stays seven so
      a full-page drag reveals drawn columns; each committed day re-keys
      the range atoms, which the bounded cache and the keep-previous hooks
      absorb. Verified on a simulator with the fingerprint's EAS dev
      client: one partial swipe moved the window two days with the
      headers over their columns; `16-week-swipe.yaml` covers it in CI.

### iOS location purpose string (2026-09-20)

- [x] `NSLocationWhenInUseUsageDescription` in the iOS Info.plist — done:
      App Store Connect accepted build 24 with an ITMS-90683 warning, so
      the string ships in `apps/ios/app.json` under `ios.infoPlist`
      beside the other five. Nothing in the app prompts for location:
      Apple's scan is static and only sees that `CLLocationManager` is
      referenced by expo-maps' `MapPermissionRequester` (never called —
      `LocationMap` sets `isMyLocationEnabled: false`) and that the geo
      and apple-calendar podspecs link CoreLocation. Decisions: the key
      is declared directly rather than through expo-maps'
      `requestLocationPermission` plugin option, which would also add
      `ACCESS_COARSE_LOCATION` / `ACCESS_FINE_LOCATION` to the Android
      manifest and claim a permission the app never asks for; the
      wording describes MapKit biasing search results toward nearby
      places, which is all location would ever be used for here. It is
      the one string here that does not end in "Nothing leaves your
      device": place search is `MKLocalSearch`, which is a call to
      Apple's servers, so that sentence would be false — do not restore
      it for symmetry with the EventKit and Contacts strings. Do not
      delete the key as unused either; the warning returns on the next
      upload.
      `ios.infoPlist` feeds the fingerprint, so this alone forces a
      TestFlight build (build number auto-increments) and a fresh
      `development-simulator` dev client for CI.

### Event notifications (2026-09-22)

- [x] Event reminders on macOS and iOS — done: `EventRecord.reminders`
      in Google's `useDefault`/`overrides` shape (also what EventKit
      alarms map onto, with `useDefault` always false), mirrored both
      ways (Google `reminders` + calendarList `defaultReminders`;
      relative `EKAlarm`s through the shared Swift bridge, absolute ones
      untouched), edited in both editors (desktop: a "calendar default"
      checkbox naming what it resolves to, else preset rows up to five;
      iOS: toggle chips plus the switch; email reminders listed, never
      edited) and delivered by `LocalNotifications`, the renamed birthday
      scheduler, now with two producers merged into one fired map and
      one OS schedule. Decisions: a `remindersChanged` flag on the
      pending op (mirror of `attendeesChanged`) because Google's PATCH
      replaces the object and email overrides must survive an unrelated
      title edit; `useDefault:false, overrides:[]` is "none" and stays
      distinct from the field being absent, which reads as the calendar
      default for a Google row synced before this shipped — migration 4
      drops the events sync tokens so every calendar re-lists once and
      no row stays absent for long; a copy-move to Apple resolves the
      calendar default into explicit popups and `previewMove` names the
      email reminders that cannot follow; Apple writes refuse
      `useDefault` and email rather than dropping them. Notifications:
      `PlannedNotification.expiresAt` lets each producer own its
      catch-up rule (a birthday all day, a meeting until five minutes
      in) instead of one 24 h window; the loop sleeps until the next
      delivery (5 s..60 s) and re-plans, debounced, on event/birthday
      invalidations; a producer whose setting is off returns nothing,
      so disabling one no longer wipes the other's OS schedule (a bug
      the birthday-only scheduler had in waiting). Settings: a new
      device-local `eventNotifications` key, on by default, with a
      second switch for Apple Calendar events that is off by default
      because Calendar.app already fires those alarms; the desktop
      permission banner now speaks of notifications in general and is
      posted once on the first start (`localNotifications.permissionAsked`
      is set before the ask, so a crash mid-prompt never nags), not
      when the first due reminder happens to fire. Hidden
      calendars do not notify (the range loader is the rpc's). Left for
      later: iOS background refresh (the schedule only updates while
      the app runs, and 60 slots fill within days on a dense calendar)
      — backlog item under Tier 2.

### Conflicts with a choice (2026-09-23)

- [x] Manage conflicts with a choice — done (2026-09-23): a 412 used to
      drop the op (server wins) and delete the user's version before
      anyone could offer it; worse, a server change a pull had skipped
      while the row was pending never came back. Now the op is parked
      (migration 5: `pending_ops.conflict_at` + `server_payload`) with
      Google's copy fetched at park time, and a persistent banner names
      the event and lists what differs (title, time, location, notes,
      guests — `describeConflict` in core, shared by both apps) with
      Keep mine / Take theirs; the queue rows offer the same instead of
      Discard. Decisions: fetch and show Google's version rather than
      the title alone (chosen by Nik); the stored copy is only a preview
      and take-theirs re-fetches live, because the pull that carried a
      newer change may already have advanced the token; keep-mine
      re-sends without If-Match rather than with the new etag (the user
      saw the comparison — a further change in between is theirs to
      overwrite); an edit of an event Google deleted is restored as a
      new standalone event under a fresh id, since the NotFound arm
      would otherwise drop it; delete ops now snapshot the deleted row
      so a parked delete can be named; a failed fetch retries instead of
      parking blind; parked ops survive a move (dropping the park with
      the etag would decide for the user) and take-theirs is refused
      until the move lands; the `notice:conflict` key and both conflict
      toasts are gone — the banner derives from `listPendingOps`.
      Fixed on the way: `discardPendingOp` never released the row, so a
      discarded edit stayed `pending` and pulls skipped it forever.
      Tests: unit (park, fetch failure, both choices, restore, re-edit,
      move), HTTP against the fake (both choices, a parked delete whose
      row a pull re-inserted), desktop e2e `conflicts.e2e.ts` on fixture
      Google. iOS has no Maestro flow for it (seeding a parked op there
      is not worth a 40-minute CI slot); verify on a device.

### Live Google suite (2026-09-24)

- [x] Tests against a real Google account — done (2026-09-24): the fake
      pinned what we believed Google does; nothing checked it. Now three
      opt-in suites sign in as a dedicated throwaway account over the real
      API — the Node engine suite (`packages/sync/src/live`, seven files:
      events, calendarList, recurring, move, attendees, conflicts, tasks,
      People), the desktop spec `googleLive.e2e.ts` and six iOS Maestro
      flows — and `google-live.yml` runs them nightly only when `main`
      moved since the last completed run, on demand, or on the
      `google-live` PR label, one run at a time. Decisions: the fixture
      suites stay the PR gate, the live suites never run under `pnpm
test`/`test:e2e`/`test:e2e:ios`; every file creates its own
      `e2e-<ts>-<runTag>` calendar/list (one per file — Google throttles
      calendar creation), deletes it after, and sweeps leftovers older
      than six hours, so overlapping local and CI runs cannot collide;
      `calendars.insert/delete` and `tasklists.insert/delete` stay
      test-only (`liveScratchRest.ts`, plain fetch, shared by Node,
      the Electron harness and the iOS sidecar) rather than widening the
      app's clients and every stub; guests are `guest-<runTag>@example.com`
      with `sendUpdates=none` through a new `GuestNotifications`
      reference (default `'all'`, unchanged for the apps) instead of a
      second real account; a `SyncInterval` reference lets the UI suites
      watch a pull land; one refresh token serves all three suites, minted
      by `scripts/google-live-token.mjs` against the desktop OAuth client
      (which iOS therefore also uses in live mode — the iOS client's
      custom-scheme redirect cannot be driven by a loopback script);
      Maestro gets a one-hour access token from the sidecar as
      `MAESTRO_LIVE_*`, never the refresh token; behind-the-back edits
      run inside the flows via `runScript` + `http`. Not covered on iOS:
      drag-to-move (Maestro 2.10 has no drag command; resize by swipe is
      best effort). Secrets: `GOOGLE_LIVE_EMAIL`, `GOOGLE_LIVE_REFRESH_TOKEN`
      (new) + `GOOGLE_DESKTOP_CLIENT_ID/SECRET`; the consent screen must
      be In production or the token dies in seven days. Verify on the
      first real run: `events.get` for a deleted event (cancelled vs
      404/410), a stale-etag PATCH of a deleted event (412 vs 404), a
      deleted task's `tasks.get`, and the iOS resize swipe.
