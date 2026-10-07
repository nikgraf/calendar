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
- [x] Production and dev side by side — done (2026-10-01): the real
      accounts live in the production app, test accounts in a dev variant
      that runs next to it, on the Mac and on the phone. This replaces the
      "single bundle id" decision above. **Two variants, not three**: no
      separately packaged desktop dev app (signing, TCC, auto-update and
      an icon for something a run from source already is) and no "beta"
      app in App Store Connect (a second record and update channel, and
      the binary tested would no longer be the one shipped) — TestFlight
      on the production id stays the pre-release path. **Desktop** was
      nearly there: a run from source already had its own userData and
      agent socket. The watched settings file was still shared, and its
      sync is two-way, so each app would have listed the other's accounts
      as `reauth_required`; a dev build now watches `solunivo-dev.jsonc`
      (`settingsFilePath`, the same `packaged` switch as
      `agentSocketPath`) and names its MCP entry `solunivo-dev`, so one
      agent's configuration can hold both. **iOS**: `com.solunivo.app`
      stays production (the installed TestFlight app keeps its data) and
      the dev client becomes `com.solunivo.app.dev`, "Solunivo Dev", with
      the dark icon master. `app.json` stays the production app as
      written and `app.config.js` layers the dev variant on top under
      `APP_VARIANT=development`; **unset means production**, so a release
      job that forgets the variable cannot ship the dev identity, while a
      dev consumer that forgets it fails visibly (no matching dev client,
      or a sign-in that cannot return). The variants need their own URL
      scheme and their own Google iOS client — two installed apps
      claiming one scheme get the redirect at iOS's whim — and production
      drops expo-dev-client's generated `exp+solunivo` scheme. The CI
      runtime-version pin, until now a CI-only overlay copied to
      `app.config.js`, became part of that file. **The config is plain
      CommonJS, not TypeScript**: it was `app.config.ts` first, and
      `ios-e2e` then ran past its 60 minutes twice. Expo evaluates the
      config for every manifest request, once more in a fresh process
      each time, and a `.ts` config is transpiled with Babel there
      (manifest 0.12 s → 0.23 s on a laptop, 0.2–0.9 s → 0.5–3 s on the
      runner). After nearly every launch the dev client's first request
      missed the launcher's 10 s budget, fell back to the launcher home
      and had to be recovered by the flows — which main never does. The
      Babel modules also landed in the fingerprint as loaded sources, so
      a `caniuse-lite` bump would have asked for a new dev client.
      Fingerprints differ per variant, so the e2e jobs compute theirs
      under the dev variant.
      Not separated, by nature: Apple Calendar, Reminders and Contacts
      belong to the device — withhold the permissions from the dev app
      (iOS) or start a dev run with the `CALENDAR_*=off` switches
      (desktop). The dev icon was first the same artwork on a plum ground,
      which rendered identical: the artwork covers the whole square.

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
- [x] Convert events ↔ tasks/reminders, new and existing — done
      (2026-09-28): the editor's Event | Task toggle now carries the draft
      across in create mode (title, day, time, notes, notifications,
      repeat rule, links) and shows for existing items too, where Save
      converts: `convertEventToTask` / `convertTaskToEvent` rpcs create
      the other kind from the form and delete the source, copy-then-delete
      with the same route-ordered transaction as the moves (one shared
      `crossStore` helper now serves both moves and both conversions).
      Decisions: the confirmation asks only when a field that is actually
      set has no home on the other side — the end time never counts (a
      task has no duration), nor do calendar-default notifications or
      links (a meeting link becomes the reminder's URL, or is appended to
      a Google task's notes; a reminder's URL becomes an Apple event's URL
      or rides in a Google event's description); guests, the location,
      email notifications (any notification toward Google Tasks), an
      inexpressible repeat rule (any rule toward Google Tasks), modified
      occurrences, a priority, alerts after the due time and the
      completed status do count. A timed event heading for Google Tasks
      (date-only) counts its time as lost and asks; toward Reminders the
      time is kept and nothing is asked. Only a chosen time counts: a
      stored event's, a drawn slot's, a parsed phrase's or an edited one —
      the editor's own 09:00 / clicked-hour default is neither carried nor
      asked about, so "+ → Task" still opens an untimed task. In create mode the
      question comes at the flip (Save would otherwise drop what the other
      form no longer shows; both models stay mounted, so flipping back
      finds the old state); for an existing item it comes at Save, from
      the stored record and the list or calendar picked by then
      (`previewEventToTask`, pure `taskToEventLoss`). A recurring event
      converts as its whole series only (the toggle needs scope "All
      events", like a move); the series' rule and an Apple event's plain
      URL reach the task form through the preview, since an occurrence row
      never carries its master's lines and the record shows only meeting
      URLs. A link travels as the task's URL and is folded into the notes
      (or a task's URL into the event description) only when the draft
      finally saves to Google, so changing the list or calendar after the
      flip cannot lose it; a task's rule reaches the event's repeat form as
      it is, never re-read from an UNTIL line. Per-occurrence conversion is
      a follow-up. The
      confirmation seam carries a structured request (move / convert /
      switch + subject) so each platform words its own buttons; the move
      strings stay as they were. The task draft now carries every alarm,
      not only the first, so a move keeps a reminder's further alerts.

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
      e2e runs against the real bridges by design (flow 10). The two
      `EXPO_PUBLIC_CALENDAR_GOOGLE=fixture` / `EXPO_PUBLIC_CALENDAR_MODEL=fixture`
      bundle flags are not that: they swap a JS-level fake in for a
      remote API and for the on-device model, and leave every bridge
      real.

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
      calendars do not notify (the range loader is the rpc's). iOS
      background refresh followed on 2026-09-27 (entry below).

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
      API — the Node engine suite (`packages/sync/src/live`, eight files:
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
      drag-to-move and resize (Maestro 2.10 has no drag command and a
      swipe from an element starts at its centre). Secrets: `GOOGLE_LIVE_EMAIL`, `GOOGLE_LIVE_REFRESH_TOKEN`
      (new) + `GOOGLE_DESKTOP_CLIENT_ID/SECRET`; the consent screen must
      be In production or the token dies in seven days. First real run
      (2026-09-24, 33/33 after fixes) settled: a stale-etag PATCH of a
      deleted event and a stale If-Match DELETE are 412s (so both park);
      Google rate-limits a burst of writes (403, handled by the op
      backoff — the suite drains until only parked ops remain); an API
      insert never adds the organizer to `attendees`, so the organizer
      cannot RSVP and a guest-side RSVP needs a second account (left on
      the fake); a series rename overwrites existing exceptions' titles
      on Google — the app now mirrors that at save (2026-09-25: Google
      copies a master's _changed_ title, description or location onto
      every exception, and leaves unchanged fields alone). The iOS
      flows found an app bug: turning a timed Google event all-day (or
      back) sent a PATCH Google refused — it merges start/end fields, so
      the old `dateTime` stayed next to the new `date` (400 "Invalid start
      time") and the op was dropped, all-day here and timed on Google.
      `toGcalTimesPatch` now nulls the unused form; the fake merges times
      like Google and has a regression test. The iOS title field gained
      the system clear button (also what the flows use to rename).

### Live suite review fixes (2026-09-26)

- [x] Six findings from a review of #88/#90 — done (2026-09-26,
      `todo/review-findings`). Maestro records every `MAESTRO_*` value,
      the live access token included, in each flow's `commands.json` and
      `maestro.log`; `::add-mask::` covers only the job log, so the
      failure artifacts now pass `scripts/redact-live-reports.ts` (exact
      secrets plus token shapes, binaries holding one and symlinks
      removed, a re-scan gating the upload), and the Maestro cache holds
      only `bin/` and `lib/` (it was shared with `ci.yml`, so a live job's
      reports could reach ordinary CI). The series-edit carry became a
      projection of the queued op rather than a plain overwrite: the op
      stores Google's master text and each exception's own text
      (`CarriedText`, migration 6), "changed" is measured against that
      across coalesced edits (an offline A→B→A is no change, as on Google),
      and discard, take-theirs and a permanent rejection restore the
      exceptions (coordinates included) except fields edited on them
      since and rows whose etag moved on (a pull already brought Google's
      version, e.g. another device's identical rename); storing values was
      necessary because Google overwrites custom exception text too, so
      nothing could be recomputed. An empty field now equals a missing one
      in that diff: the editor always sends `location: ''`, which used to
      wipe the exceptions' own locations locally. The iOS sidecar records
      each scratch id as it is created and keeps what a delete missed
      (teardown exits 1). A click on the 23:00 row opened the editor at
      23:00–24:00, which validation rejects; the clicked hour now goes
      through `slotTimes` like a drawn slot (ends 23:59). The live
      recurring-delete test asserts the assembled occurrences, `drain`
      fails with the leftover ops instead of returning, and the desktop
      spec's free slot no longer wraps to 23:00. Deferred items are one
      Tier 1 entry in `todo.md`.

### iOS background refresh for notifications (2026-09-27)

- [x] iOS background refresh for local notifications — done
      (2026-09-27): the ≤ 60-slot OS schedule only updated while the app
      ran, so a dense calendar ran dry within days and an event added
      elsewhere never notified until the next launch. Now a background
      task (`expo-background-task`, registered on mount with a 30-minute
      minimum interval) runs `backgroundRefresh`: `syncAll` bounded to
      20 s, then `LocalNotifications.run()` regardless — a pull that is
      slow, offline or dies (a Keychain read while locked) still leaves
      a schedule refilled from local data. Decisions: the effect lives
      in `packages/sync` so the ordering and the budget are unit-tested
      against a stub engine; the task is defined in `index.ts` before
      `registerRootComponent`, because a background launch runs it
      before anything mounts, and it reuses the app's one runtime (a
      mount on the same launch is harmless: `syncAll` is gated, `run`
      serialized); both modules load through a guarded `require` so OTA
      previews on older binaries keep working. expo-background-task
      submits a `BGProcessingTask` (network required, no power
      requirement), not the `BGAppRefreshTask` the backlog named — iOS
      tends to grant it overnight or while idle, which is when slots run
      out; the foreground refresh stays the correctness path. Google
      tokens are now stored `AFTER_FIRST_UNLOCK` (chosen by Nik) so a
      pull can run while the phone is locked; the Keychain keeps an
      item's accessibility on update, so tokens move to a new key
      (`tokens.v2.<id>`, `apps/ios/src/tokenStore.ts`): the new item is
      written first and the old one deleted only after that succeeded
      (the refresh token is the only copy — deleting first lost it on a
      failed write, caught in review), reads fall back to the old key
      and migrate it the same way. Added the
      missing 60-slot cap test. No Maestro flow: BGTasks cannot be
      triggered from it; verify with `triggerBackgroundRefreshForTesting`
      in a debug build or the debugger's `_simulateLaunchForTaskWithIdentifier:`
      on `com.expo.modules.backgroundtask.processing`. Fixed on the way
      (CI caught it): the four notification settings sections merged a
      change into the atom's last read, so a second toggle before the
      re-read undid the first; `useSettingsEditor` keeps the last value
      sent as the section's truth (the UI is the only writer of those
      keys) and falls back to the stored one on a failed save.

### iOS two-day view (2026-09-28)

- [x] iOS "2 Days" view between Day and Week — done (2026-09-28): a
      fourth segment shows the focused day and the next one side by
      side. It is the week timeline with two columns: `DayTimeline`
      already draws `days.length` columns with per-day swipe paging and
      its own header cells, so the change is in the shared
      `useCalendarNavigation` (`'twoDay'` in `CalendarViewKind`, a
      `viewColumns` helper replacing the scattered `7` / `=== 'week'`
      literals) plus the iOS segment. Decisions: the window is anchored
      on the focused day (`[focused, focused + 1]`, as Apple's and
      Google's multi-day views do), so unlike the week's Monday-snapped
      window it needs no state of its own — a swipe moves `focused` by
      the columns crossed, a chevron by two, Today shows today and
      tomorrow, and a header tap opens that day in the Day view as in the
      week. `TWO_DAY_SWIPE_BUFFER` is two, the week's rule of buffer =
      visible columns, so a full-page drag reveals drawn columns and can
      commit both days. Two columns (~170 pt on a phone) keep the day
      view's block layout: the column divider now follows
      `days.length > 1` and the dense text only `days.length > 2`. The
      title reuses the week format on a two-day span ("Sep 30 – Oct 1,
      2026"). Desktop keeps Day / Week / Month (the shared type gains the
      value, its segment is its own literal); the chosen view is still
      not persisted, on either app. `18-two-day-view.yaml` covers the
      chevrons, Today and a swipe in CI; `titleFor` and `viewColumns` are
      exported for unit tests.

### Multiple time zones (2026-09-29)

- [x] Time zones in settings — done (2026-09-29): up to three IANA zones
      per device, one primary. The primary zone replaces the device zone
      for everything the UI draws: both roots (`CalendarApp`,
      `CalendarScreen`) gate on `useTimeZones()` and hand the primary
      to the body where `Temporal.Now.timeZoneId()` used to be, so the
      hour axis, event placement, "today", the now-line, navigation,
      quick add, find-a-time and the editors all follow it, and new
      events carry `startTimeZone = primary`. The other zones annotate:
      a dimmer second line under each hour label (built from the instant
      of that hour on the first visible day, so half-hour zones show
      minutes and a DST gap resolves; a DST change inside a multi-day
      strip can put another column an hour off, which the blocks' own
      times never are), a third line on tall event blocks and a helper
      line under the editor's time inputs. Decisions: a new
      `timeZones` device_settings key (`ViewPreferences` is replaced
      wholesale by its callers), decoded through a schema that validates
      every id against Temporal so a zone tzdata dropped reads as the
      default single device zone rather than a grid that throws; the
      picker's catalog is a checked-in canonical IANA list with modern
      spellings (ICU's `Asia/Calcutta` → `Asia/Kolkata`), the same on
      both apps since Hermes lacks `Intl.supportedValuesOf` — but engines
      accept different spellings (Hermes rejects `Asia/Kolkata` and takes
      `Asia/Calcutta`; V8 takes both), so a device stores whichever
      spelling its engine validates (`runtimeZoneId`) while display,
      search and test ids go through `canonicalZoneId`. The first iOS
      run stored `Asia/Kolkata`, failed the schema's Temporal check on
      the next read and reset the whole list; zone labels
      are the city part of the id (Intl's short names are inconsistent on
      Hermes). Gating rather than falling back to the device zone: a
      first frame in the device zone would, near midnight with a distant
      primary, seed the focused day and "today" with the wrong date.
      Stays on the device zone: `LocalNotifications` (alarms are
      instants; a birthday "09:00" means the phone's 9:00; the layer is
      built at startup), EventKit's floating-event zone, and timed Apple
      reminders (`dueTime` is floating wall clock, drawn at that hour in
      whatever zone the grid uses). iOS event pickers pass
      `timeZoneName={primary}` and convert through `pickerDates.ts`, so
      a primary that differs from the device zone round-trips exactly;
      reminder, task and birthday pickers keep the device-local helpers.
      The gutter widens per zone (desktop `w-16`→`w-24`→`w-32` shared by
      header and lane; iOS `gutterWidth()` also fed to the task drag so
      drops land in the right column). Tests: core catalog / label /
      schema units, sync round-trip, `timeZones.e2e.ts` (a seeded
      UTC + Kolkata pair, host-independent, plus the section's add /
      promote / remove / cap), Maestro `19-time-zones.yaml` (Honolulu
      primary, Kolkata secondary: "3:30 AM" under noon).

### A gone calendar no longer stalls the account (2026-09-29)

- [x] Nightly live runs 36374700458 and 36517901490 went red — done
      (2026-09-29, `todo/live-nightly-gone-calendar`). The three live jobs
      share one account, so each app lists the other jobs' scratch
      calendars too, and Google keeps listing a deleted calendar for
      minutes (docs/google-sync-and-testing.md, calendarList). Once its
      `events.list` answers 404, `syncAccount` used to fail at that
      calendar, and because it syncs calendars one after another, the
      calendars sorted after it, tasks and contacts never synced. An
      incremental list never reports a deletion older than its token, so
      the account stayed stuck (iOS: every pass for 11 min; its run list
      and a server-side event never arrived). A real user who deletes a
      calendar elsewhere could hit the same. Decisions: a 404 from one
      calendar's `events.list` skips that calendar for the pass, keeps its
      rows and drops the calendarList sync token, so the next pass lists
      calendars in full; that removes the calendar once Google stops naming
      it. The first cut purged the calendar on the 404, which a review
      rejected: Google says to retry 404s, and after a transient one an
      unchanged calendar would never have come back through the delta. A
      404 from one list's `tasks.list` skips that list and keeps its rows
      (task lists are listed in full every pass). Any other failure still
      fails the account pass as before. The Node calendarList test
      polls up to three minutes for the removal instead of asserting after
      one pass, and the desktop live spec now dumps screenshot, DOM and app
      log on a failure. The desktop failure of 36517901490 (a created
      event never rendered; the later tests chained on it) did not
      reproduce locally, not after a fresh deletion and not at the
      nightly's 16:00 slot, so its cause is still open; the dump is there
      for the next time.

### Settings export/import and the watched settings file (2026-09-30)

- [x] Settings as a file — done (2026-09-30,
      `todo/settings-export-import`): a versioned `SettingsDocument`
      (`packages/core/src/settingsDocument.ts`) carrying the device
      settings (time zones, event notifications, birthday reminders, view
      preferences), the desktop's screen privacy under `desktop`, and
      every account as a sign-in checklist with its calendar/list
      visibility. Export… / Import… on both apps (desktop: file dialogs
      over preload IPC, the document itself over the rpc seam; iOS: the
      share sheet via React Native's `Share` with a file in the cache
      folder, and `expo-document-picker` for the pick — a native module,
      so the iOS fingerprint moved), plus the desktop's watched
      `~/.solunivo/solunivo.jsonc` (`CALENDAR_SETTINGS_FILE` overrides it)
      that is applied on start and on every save and written back when
      settings change in the UI. Decisions: **the document never holds
      tokens or secrets** — desktop and iOS use different Google OAuth
      clients, so refresh tokens could not cross platforms anyway, and a
      desktop refresh token is a non-expiring bearer credential; a Google
      account the file lists that is unknown here is created as
      `reauth_required` with no token, so the existing "Sign in again"
      row is the checklist and `finishAddAccount` (now case-insensitive
      on the email) keeps the id. An import never removes anything and
      never connects Apple providers (no TCC prompt from a file);
      sections are written only when they differ, notification toggles
      go through the setters' permission + reschedule path
      (`notificationSettings.ts`), and `desktop.screenPrivacy` reaches
      the Electron main process through the `PlatformSettings` seam (iOS
      provides `none` and notes the section as desktop-only). Accounts
      are keyed by `kind` (`google` + email, `apple-calendar`,
      `apple-reminders`) because both Apple accounts share
      `provider: 'apple'` and an empty email. Apple calendar ids are per
      device, so Apple calendars match by EventKit source title + title
      and Reminders lists by title, best-effort. Visibility for rows not
      in the database yet (account not signed in, Apple not connected,
      first sync pending) is parked in `device_settings.importedVisibility`
      and applied after each calendar/list sync pass (`applyPendingVisibility`
      in the engine, under one semaphore shared with the import so a pass
      cannot drop what an import just parked); the export merges the
      parked entries back in, or the desktop write-back right after an
      import would erase them from the file. The watched file is two-way:
      file → app on change (directory watch, since editors save by
      rename; hash of the last applied/written text tells our own writes
      apart, a parse error is reported and not recorded so the next good
      save applies, an unapplied edit on disk wins over a pending
      write-back), app → file via `jsonc-parser` edits leaf by leaf so
      comments and unknown keys survive (`accounts` is replaced as a
      whole; comments inside it are lost). A minimal file fills in to the
      full state after the first write-back, and a deleted account entry
      comes back — the file mirrors the device. The app never creates the
      file on its own ("Create file" in Settings does). The e2e harness
      always points `CALENDAR_SETTINGS_FILE` under its temp profile: HOME
      is not isolated, and no run may touch a developer's real file. Core
      imports `jsonc-parser/lib/esm/main.js` directly: the package's
      `main` is a UMD build whose parts are
      required through the wrapper's own `require` argument, which both
      rolldown (the Electron main bundle) and Metro bundle without them —
      the first iOS CI run died at launch with "Requiring unknown module
      ./impl/format". One deep import fixes every bundler; a per-bundler
      alias did not.
      Directory watchers are only the fast path; the source of truth is a
      periodic check (every 5 s, on window focus and when Settings asks
      for the status): one stat of the file, a reload when its identity
      or modification time moved, a re-attach when the folders to watch
      changed. It covers what a watcher cannot — the folder created after
      the app started (the app never creates it itself, and a watch
      cannot attach to a missing folder), a folder deleted and recreated
      (the old watch goes silent), events dropped on synced volumes.
      Watching the home directory for the folder to appear was rejected:
      it solves one of those cases, and home is noisy (every shell
      history append fires there). The file stays opt-in: auto-creating
      it would put account emails and calendar names in a dotfolder
      nobody asked for, switch on the two-way mirror for everyone, and
      collide with a setup script that links the real file later. A
      symlinked file (a dotfiles repo) is written at its resolved target
      — renaming over the link would replace it with a regular file and
      silently detach the repo — and both the link's folder and the
      target's folder are watched, since an in-place edit at the target
      fires only there. `settingsFileFs.test.ts` proves both against a
      real temp directory.
      The desktop shows two cards so the two ideas stay apart: "Export &
      import" is a one-off copy for another device, nothing watched;
      "Settings file" explains the watched file — what it is good for (a
      new Mac set up from dotfiles, scripts and coding agents changing
      settings by editing a file), what it exposes (the settings in plain
      text, including connected accounts' email addresses and calendar
      names, readable by anything that can read the home folder — never
      passwords or tokens) — and holds the one button that creates it.
      Local account ids come from `crypto.randomUUID()` everywhere: native
      in Node and Electron, and on Hermes filled in by the Web Crypto
      polyfill (`apps/ios/src/polyfills.ts`, expo-crypto's native
      `randomUUID` next to the `getRandomValues` it already installed) —
      the hand-rolled `Math.random` UUID the iOS host carried is gone, and
      an import no longer names accounts differently from a sign-in.
      Tests: `settingsDocument.test.ts` (parse, version gate, Hermes zone
      spelling, comment-preserving merge), `settingsExport.test.ts`,
      `settingsImport.test.ts` (preview = import, reauth row, parked and
      applied visibility, Apple matching), `settingsFileSync.test.ts`
      (loop guard with a fake disk), desktop `settingsFile.e2e.ts` (file
      at launch, live edit, write-back with comments, Create file) and
      Maestro `20-settings-file.yaml` (export opens the share sheet,
      import opens the document picker). The share sheet titles the file
      without its extension and hides the app's elements from the
      accessibility tree while it is up, so the flow keys on "Save to
      Files" and dismisses with a swipe that starts inside the sheet.

### Agent gateway: MCP and CLI access for other agents (2026-10-01)

- [x] Let other agents on the Mac use the app — done (2026-10-01,
      `todo/agent-gateway`): a gateway in the Electron main process that
      Hermes, OpenClaw or a script reach over MCP or a CLI, with a
      per-agent grant set in Settings → Agents. New package
      `packages/agent` (policy, refs, tool contract, enforced reads,
      planned writes, approvals, store), the host in
      `apps/desktop/electron/agent/`, and `solunivo-cli`, a dependency-free
      relay the packaged app ships in `Contents/Resources`.
      Decisions: **one gateway, two front ends** — MCP and the CLI are the
      same 15 tools over the same `callTool`, so neither can drift or skip
      a check; the tool set is curated (no accounts, settings, conflicts,
      queue, moves or conversions), not the ~55 backend rpcs. **MCP is
      served in main, the relay only pipes**: `@modelcontextprotocol/server`
      2.2.0 implements the 2026-07-28 revision and still answers the 2025
      `initialize` handshake (effect's bundled `McpServer` stops at
      2025-11-25); it brings zod into the main bundle, while the relay
      stays 6 kB of node built-ins and runs under the app's own binary
      (`ELECTRON_RUN_AS_NODE`), so agents need no Node — at the price of
      keeping the RunAsNode fuse enabled until a Swift relay exists. The
      SDK is handed a pass-through Standard Schema that only advertises
      the JSON Schema: the gateway's Effect decoder is the one validator.
      **Levels are per calendar and per list** (none < free/busy < read <
      ask < write), with guests and contacts as separate switches; `none`
      answers NotFound so a denial never confirms a hidden calendar;
      calendars hidden in the app are `none` for every agent (range reads
      filter on `is_visible`, and a grant should not show more than the
      UI). **The gateway resolves a write's real container first**:
      EventKit and Reminders address items by id alone and ignore the
      calendar or list passed in, so without that a ref pairing a granted
      calendar with another calendar's event would have written it — the
      backend has no permission checks of its own below the UI. Guests are
      gated on create, edit and delete (all three reach other people);
      RSVP only needs the calendar level. **Ask-first** stores the planned
      write with a summary the app wrote, waits ~25 s, then hands back a
      request id to poll; approval is a conditional status transition
      (two clicks execute once) and re-plans from the stored input, so a
      narrowed grant or a removed agent still stops it; it is never asked
      through MCP elicitation, which the agent's own client could answer.
      **Storage is a separate `agents.db`**, not a migration in
      `packages/db`: the phone never has agents, `migrate.test.ts` and the
      yield-point-sensitive sync tests stay untouched, and grants cannot
      ride along with anything that syncs or exports — they are edited
      only over `agents:*` IPC and are not in `SettingsDocument`, so an
      agent with a shell cannot widen itself through the watched settings
      file. The token is 256 random bits shown once; only its SHA-256 is
      stored, in SQLite — a hash cannot authenticate, and safeStorage
      would add nothing while any same-user process can read calendar.db.
      That is the stated threat model: a guardrail for agents that connect
      through it, not a sandbox. **Transport**: a Unix socket under
      `~/.solunivo/run` (0700 dir, 0600 socket created under a umask),
      open only while an agent exists, one authenticating hello line, the
      agent looked up again on every call; same Mac only. **No window**:
      the app already kept running after its last window closed; it now
      takes a single-instance lock (after the userData override), starts
      without a window on `--background` (what the relay passes when it
      launches the app via `open -g`), and opens a window on demand for a
      notification click. A login item and a menu-bar item are follow-ups.
      An adversarial review before the first push found no way past a
      grant and no existence oracle, but did find: summaries that
      clipped guests and text (an approved invitation could carry a ninth
      guest and a payload past character 160) — summaries are now never
      shortened and inputs are capped instead; a summary that went stale
      while it waited (the same agent could rewrite an event between the
      question and the answer) — **an approval now only runs a plan whose
      summary equals the approved one**, and adding a guest shows the
      location and notes that guest will get; refused and finished socket
      connections that were ended but never destroyed, so a peer without
      a token could pin every slot; series-wide edits made through a
      moved exception dragging the whole series (now based on the slot);
      all-day series date changes answered "done" and dropped (now
      refused); Apple occurrences resolved from the series' first
      occurrence; occurrence slots that were never validated; CLI replies
      over 1 MiB; a log that stored every input and could be flooded by
      refusals; the request age limit only enforced by the hourly sweep.
      Each has a regression test (`gateway.hardening.test.ts`,
      `socketServer.test.ts`). A second review of the PR found four more
      of the same family: a `series`/`following` write ignored guests on
      the other exceptions it rewrites or cancels; its summary showed the
      clicked occurrence's text while the master's is what gets written
      (and mailed to a new guest); existing guests were only counted, so
      swapping one for another did not void a waiting approval; and an
      MCP session that closed itself kept its socket and slot. A summary
      is now built from the written event and names every guest reached.
      Found on the way: two quick edits in the grant editor overwrote each
      other (each built on the last state main had sent back) — the
      editor now builds on its own last edit; the e2e spec caught it.
      Tests: `packages/agent` (policy matrix, refs, times, DTO redaction,
      store, and the gateway over the Apple Calendar and Reminders fakes:
      forged refs, read-only, guests, occurrence routing, approvals),
      `apps/desktop/electron/agent` (a real socket, MCP against the
      official client in both eras, CLI flags), desktop
      `agentGateway.e2e.ts` (the built relay spawned against the launched
      app), and `solunivo-cli --version` from the packaged and the signed
      app in CI. Not verified here: the relay under the hardened runtime
      (first signed CI build), a real Hermes/OpenClaw session, relay
      auto-launch of the installed app, a real guest invitation.

### Settings in its own window (2026-10-02)

- [x] Settings as a macOS settings window — done (2026-10-02,
      `todo/settings-window`): Settings left the main window's modal for
      a window of its own, opened from the application menu
      (Settings…, ⌘,) as the HIG asks. The app had no menu of its own
      before (Electron's default), so ⌘, was a renderer key handler that
      needed a focused main window; as a menu accelerator it now also
      works with no window open. Decisions: **toolbar panes, not a
      sidebar** — five panes (General, Accounts, Notifications, Agents,
      Advanced) replace the single twelve-section scroll; a System
      Settings-style sidebar only pays off with many more. The window
      follows the HIG's settings-window rules: one at most, fixed size,
      minimize and zoom dimmed, title = the pane in view, reopens on the
      pane viewed last (`localStorage`), changes apply at once. **One
      bundle, a hash route** (`#settings/<pane>`) instead of a second
      vite entry: the rpc seam was already per-`webContents` and every
      broadcast already went to all windows, so the second window needed
      no backend change. **The pane lives in the URL hash**: the main
      process moves an open window to a pane by navigating the hash
      (same-document, the page gets `hashchange`), so no message can
      arrive before the page listens. Review found the two ways that
      still lost a request made while the window was opening: the main
      process parsed `getURL()`, which is empty until the first
      navigation commits (`Invalid URL`, request rejected), and the page
      wrote its own pane back over the hash after its first render,
      undoing a navigation that landed in between. Now a pane asked for
      during loading is kept and applied on `did-stop-loading`, and the
      page only ever reads the hash (`useSyncExternalStore`; a tab click
      navigates it) — nothing writes state back over it. All panes stay
      mounted (hidden),
      so an agent token shown once or a half-typed name survives a look
      at another pane. **The toolbar is HTML** in a hidden title bar —
      Electron cannot host an `NSToolbar`. **No settings button in the main
      window's toolbar**, as the HIG has it: the gear is gone, the menu
      is the way in; the sidebar's "Manage accounts…" stays and opens the
      Accounts pane.
      `windows.ts` now tracks the main window explicitly:
      `getAllWindows()[0]` would have focused Settings on a notification
      click, and a Dock click with only Settings open now reopens the
      calendar. The approval dialog, conflict banner and dropped-change
      toast stay main-window only. Not done: auto-sizing the window to
      each pane's height (fixed 680×620, panes scroll). Tests: the e2e
      harness attaches to the settings window as a second CDP target
      (`app.openSettings(pane)` / `closeSettings`); every spec that used
      the modal drives the window instead, `timeZones.e2e.ts` asserts a
      change made there redraws the calendar window, and `flows.e2e.ts`
      covers one-window-at-most, pane moves without a reload and the
      last-viewed pane. The menu item itself is not in the suite (CDP
      cannot press a native menu accelerator); it was checked by hand
      through the main-process inspector: Settings… opens the window,
      also with the main window closed.

### Calendar mirrors (2026-10-02)

- [x] Calendar mirrors — done (2026-10-02, `todo/calendar-mirrors`): a
      mirror copies several sources (Google and Apple calendars, Google
      task lists, Reminders lists) one way into one destination calendar,
      reduced to an allow-list of fields, so a calendar can be shared
      without the details: a "Busy"-only calendar for friends, household
      reminders as events with their done state, title and place of a
      work calendar in a family calendar — all on the user's devices, no
      service. Also: undated tasks show on today in both apps (and a task
      completed late stays on the day it was completed), the editor opens
      an undated task as "No due date" rather than silently giving it one.
      Decisions: **a mirror, not a workflow** — one way, the app owns the
      copies and overwrites them; no rule engine, three presets
      (Availability, Title and location, Full details) and an Advanced
      disclosure with fields, the busy label, months ahead (1–24, default 3) and filters. **Reconcile with no mapping table**: the destination
      is the state, any device can run a mirror, a cut-off run runs again;
      the price is that every input must be device-independent (own
      queries past local visibility, the mirror's own time zone, portable
      keys — EventKit's external identifier is new on both bridges).
      **Google writes bypass the pending-op queue** (copies are derived;
      the queue would list every one as an unsynced change) and use
      `events.update` (PUT), since a switched-off field must leave the
      copy and PATCH keeps omitted fields; a derived id (`slnvmr` +
      hash) makes a second device's insert a 409 and a confirming replace
      revives a deleted copy — all pinned live first (`mirrors.live.ts`).
      **Markers are opaque** (the key is salted with the mirror id, the
      content hash covers only what was written): the destination is
      shared with people who can read both carriers. **Setting a mirror
      up by hand on two devices does not cooperate** — the settings file
      is the only way across, an imported mirror arrives switched off,
      and a device whose definition is older than a copy's revision stands
      back. **Availability merges overlapping events** into one block
      (`mergeBusy`, moved to core from the agent package), so nobody can
      count meetings; **private events copy as the busy label** by
      default, and until the one-time re-list after the upgrade every
      event counts as private. **Two backstops** for what cannot be
      checked (EventKit never says whether iCloud caught up): a large
      removal waits ten minutes, a third identical write within a day
      pauses the mirror. **Apple destinations are iCloud, CalDAV or
      local** (Exchange drops the URL that carries the marker). **The
      editor can create the destination**: Google under the new
      `calendar.app.created` scope (the narrowest that allows
      `calendars.insert`; sign-in now asks for it, an older sign-in is
      told to sign in again), Apple in the default account. **Copies are
      hidden in the app** — the originals are already drawn — in every
      shared read. **An empty pull page no longer invalidates
      EVENTS_KEY**, or every quiet poll would recompute. Rejected: a
      Zapier-style workflow; cutting the app-side undated-task change
      (asked for); iCloud key-value sync of definitions (a new
      entitlement in every build). Tests: core `mirror/mirror.test.ts`,
      `sync/mirrors.test.ts` (two devices — each its own database and
      engine — over one fake Google and one fake EventKit store: sync
      lag, a stale device, an older definition, another mirror, unsynced
      edits, the large-removal brake, the rewrite breaker, reminders with
      done state, a raced Apple duplicate, a hidden source), repo and
      fake tests, `mirrors.live.ts`, desktop `mirrors.e2e.ts`, Maestro
      `21-mirrors.yaml` (not run locally: the dev client needs the Swift
      changes). Review (2026-10-03) found and fixed: a stale device's 409
      path replaced a copy blindly (now it reads the event and stands back
      from a newer revision, else replaces with If-Match); a definition
      that excludes everything leaves no revision carrier (bounded: deletes
      are not counted by the breaker, so the right device keeps deleting
      while the stale one trips its own after two rounds); refused Apple
      batch writes counted as applied; moving a mirror to another calendar
      left its copies in the old one (now removed first); a zoned reminder
      was placed by this device's wall clock instead of its instant. Open:
      the `calendar.app.created` scope is on the consent screen (added
      2026-10-03) but a narrow-scope sign-in creating a calendar is
      untested; a real two-device run, reminder external ids across
      devices, the new Swift paths against real EventKit.

### Effect 4.0.0 stable (2026-10-03)

- [x] Move off the release candidates onto stable Effect 4.0.0 — done
      (`todo/effect-4-stable`): all five `effect*` packages pinned
      exactly to `4.0.0` in the catalog. Decisions: **the pin stays
      exact** — rpc, sql, http and reactivity, the modules this app
      leans on most, are still `@stability unstable` and may break in a
      minor, so every bump stays a deliberate, all-packages-together
      change (Dependabot keeps ignoring `effect*`). **No release-age
      exclusion**: stable shipped 2026-10-01 and the 2-day
      `minimumReleaseAge` was waited out rather than bypassed; the code
      was migrated against rc.118, which already carried every change
      that needed an edit. The cost from rc.115: rc.118 moved every
      `effect/unstable/*` module to `effect/*` and removed the old paths
      (~100 files, imports and one `vi.mock` only); the deep SQL imports
      stay deep (`effect/sql/SqlClient`, never the barrel — the Metro
      rule is unchanged); `Schema.isLengthBetween` became
      `isBetweenLength`. The custom rpc protocols in `rpcDuplex.ts`
      needed nothing — both `Protocol` shapes are field-for-field what
      rc.115 required. `effect` no longer has runtime dependencies (159
      fewer packages installed). **Vitest stays 4**: `@effect/vitest`
      declares a Vitest 5 peer (it already did at rc.115) but the suites
      only use `it.effect` / `expect` and pass unchanged, so vite-plus 1.0
      (Vitest 5) stays a separate sweep item. The iOS native fingerprint
      did not move, so the existing EAS dev client covers the change.

### Capture from text or photo (2026-10-04)

- [x] Paste an email (desktop) or share a screenshot/poster (iOS share
      sheet) → the events it describes, reviewed before anything is
      written — done (`todo/capture-text-photo`). Decisions: **OCR first,
      not image input**: Apple Vision reads the image on-device
      (`RecognizeDocumentsRequest`, paragraphs in reading order, OS 26 —
      the model needs 26 anyway) and the text goes through the existing
      text-only `generateJson`; native image input exists only on OS 27
      and `@react-native-ai/apple` 0.12 is text-only, so it is a backlog
      follow-up, and `TextRecognizer` is its own seam in `packages/ai`
      (the permanent OS 26 path, fakeable) rather than an image field on
      `LanguageModel`. **The quick-add item shape, minus recurrence, in an
      `{events: […]}` array** (the Swift `dynamicSchema` already did
      arrays; `maxItems` now maps to `maximumElements`); every item goes
      through `normalizeQuickAdd`, an undated item is dropped — never
      placed on today — and a date the model wrote without a stated year
      that lands well in the past rolls forward a year (deterministic,
      `resolveUnstatedYear`). **Text is prepared deterministically**
      (`prepareCaptureText`: quoted replies cut, over-long tokens clipped,
      a 6000-char cap at a line boundary for the ~4k-token context, the
      cut reported as `truncated`). **Review is a list whose rows open the
      existing editor**; only that editor's Save marks a row added
      (`onSaved` on both editor models), so calendar choice, the Event |
      Task flip and the create path are unchanged and "never an auto-save"
      holds; a single event skips the list, like quick-add. **Desktop
      entry is ⌘V** (the stock Edit › Paste role delivers the same event):
      on the grid any text or image, in the ⌘K input only an image or
      multi-line text; a menu item and a main-process clipboard read were
      not worth their cost. One dialog at a time: the list unmounts while
      a row's editor is open (both `Dialog`s close on one Escape), and on
      iOS the edit sheet renders inside the capture sheet (sibling Modals
      never present together) while progress and errors are a banner.
      **iOS share sheet via `expo-sharing`'s receive support** (first
      party, experimental): its plugin is wrapped
      (`plugins/withShareExtension.cjs`) because it writes the array of
      schemes into the extension's plist and the extension crashes on a
      non-string, and because the share sheet would show the target
      name; the extension's bundle id and app group are pinned per
      variant. The extension opens the app over an unofficial responder-
      chain call (upstream's choice, documented as a review risk). Only
      `getSharedPayloads()` is used — the hook reads native state on
      every render and the "resolved" variant makes a network request —
      and `expo-sharing` is required lazily so an older binary under new
      JS does not crash. A shared image is deleted once read. **A model
      fixture for both e2e suites**: `CALENDAR_MODEL=fixture` is answered
      in Electron main after the same validation (IPC stays on the tested
      path), `EXPO_PUBLIC_CALENDAR_MODEL=fixture` is bundled for CI; the
      fixture is a one-line-per-event grammar with dates relative to the
      prompt's "today", so specs stay date-independent, and it accepts a
      `capture-fixture` deep link as the stand-in for a share. Open: the
      real share sheet and extension on a device (both variants), HEIC
      from Photos, whether 6000 chars / 8 events fit the context, and the
      interactive EAS credentials run for the extension App IDs.

### Per-person birthday reminders (2026-10-04)

- [x] Per-person birthday reminder overrides — done
      (`todo/birthday-reminder-overrides`): the birthday detail view on
      both platforms edits that person's lead days, saved as they change
      (no Save button; the iOS sheet's header reads Done for a birthday).
      Decisions: **a per-person list that inherits until touched**, not
      extra lead days on top of the general ones: the boxes start on the
      general list, the first change stores the person's own, an empty
      list mutes them, "Use defaults" removes the entry — so "Mom: 2
      weeks before as well" and "never for this colleague" are one
      control. The general switch still gates everything, and an
      override never asks for permission (it cannot turn reminders on).
      **Keyed by name + month + day (`birthdayMergeKey`), not the merged
      record id** the backlog proposed: that id is the first source's and
      changes when a Google contact appears or goes, when an account is
      re-added (generated account id), and differs between the Mac and
      the iPhone; the merge key is what makes two sources one person in
      the first place. Accepted cost: a rename in the address book drops
      the override, and two people with the same name and birthday share
      one. **Travels in the settings document** (`birthdayReminderOverrides`,
      a list replaced as a whole in the JSONC like `mirrors`); an import
      joins by person — the file's entry wins for the same person —
      and never removes one. One `device_settings` row
      (`birthdayReminderOverrides`), per-entry decode so one bad hand
      edit does not drop the rest, canonical order so an unchanged set
      writes identical text. A write runs a `LocalNotifications` pass
      itself, since its loop re-plans only on birthday and event
      invalidations. Both Settings sections list the people with their
      own lead days, with a Reset each, so a muted person stays
      findable. **The detail view re-reads both settings as it opens**
      and enables its controls only once they are back: on desktop the
      main window held an idle copy of the general lead days changed
      meanwhile in the Settings window (the e2e caught it — first open
      after the change showed the old list, a reopen the new one), and a
      toggle would have saved an override built from it. Review fixes:
      every partial write of the list goes through one locked
      read-modify-write (`updateBirthdayReminderOverrides`), and an import
      joins the file's entries into what is stored when it runs, not into
      the list it planned against — it can sit on the iOS permission
      prompt while the user mutes someone. The detail view's optimistic
      value lasts only until its save's refetch lands; after that the
      stored list is the truth, so a Reset in Settings with the detail
      open shows up instead of being shadowed. iOS e2e seeds
      the person through the fixture Google account's People
      connections (`GoogleFixture.people`, contacts on), a week from
      today inside today's month so no day-view flow meets the chip;
      flow 23 reaches it from the month grid. Open: on-device check of
      the pending iOS notifications after an override.

### Full-history follow-ups (2026-10-04)

- [x] RDATE series and long COUNT series — done
      (`todo/full-history-follow-ups`). **A set of only RDATE lines never
      rendered**, which the follow-up note undersold as "unbounded":
      rrule-temporal refuses a rule without FREQ, `assembleWindow` skipped
      the master on every read and logged it, and its NULL end kept it in
      every window's masters query. Such sets come from other clients,
      ICS imports and agent writes. Decisions: **no RDATE parser of our
      own** — `buildRuleString` adds `RRULE:FREQ=DAILY;COUNT=1` (exactly
      DTSTART) and the library adds the RDATEs and takes the EXDATEs as
      for any rule, every value form included; the live suite proves
      Google counts DTSTART as the first instance (an instance PATCH on
      it lands) and draws what we expand. **DTSTART is always an
      occurrence**: probed live, Google draws an event's start even on a
      day its rule skips (Tuesday start, `BYDAY=SU;COUNT=2` → the Tuesday
      plus two Sundays — DTSTART outside COUNT), where rrule-temporal
      drops it. `buildRuleString` lists DTSTART as an RDATE too, which
      the library dedupes on a rule day; it costs the COUNT query plan
      nothing and an endless rule ~0.02 ms per read. The review of #109
      found the visible case: a this-and-following split on an RDATE
      occurrence the rule skips starts the new master there, and the
      calendar drew neither half's copy of it while Google drew it.
      COUNT arithmetic for a split counts the RRULE line alone from the
      original DTSTART (`ruleOccurrencesBefore`), so an off-rule start is
      never consumed. **The stored end reads RDATE
      values**: a plain UNTIL is still read off the rule (a long UNTIL
      series is never enumerated); COUNT, RDATE-only and UNTIL/COUNT with
      RDATE enumerate the set once through that same rule string, so the
      bound and the drawing cannot disagree; an endless rule stays
      endless whatever its RDATEs say. Migration 8 recomputes the column
      for stored masters with an RDATE line — sync never rewrites an
      unchanged row, so an ended series would have stayed NULL, and a
      re-list of every calendar was not worth it. **Two split bugs rode
      along** in `remainingRecurrence`: the new half kept every RDATE
      value (the library emits values before DTSTART, so the old half's
      showed twice) — it now keeps only values after the split; and the
      remaining COUNT subtracted the full set's instances up to the
      split, RDATEs added and EXDATEs taken away, where RFC 5545 counts
      only what the rule generated — it now expands the RRULE line alone.
      **A split of an RDATE-only set** can leave a half with nothing to
      repeat: the old half becomes a one-instance series through the same
      COUNT=1 rule (it keeps its exceptions, and its update is a PATCH,
      where an absent `recurrence` would keep the old dates on Google);
      the new half, a create, becomes a single event (`isRecurringSet`).
      Left as it was: a this-and-following edit that moves a rule
      occurrence onto a day an explicit BYDAY skips keeps the old COUNT,
      so the new series ends one occurrence late — on Google too (its own
      UI rewrites BYDAY instead).
      **Long COUNT series: measured, no change.** A one-week window two
      years into a series starting ten years back, a fresh `RRuleTemporal`
      per read as `expandRecurringEvent` builds it (rrule-temporal 2.2.5,
      Node 24, M-series Mac): DAILY COUNT=5000 0.02 ms, WEEKLY MO/WE/FR
      COUNT=2000 0.015 ms, MONTHLY BYMONTHDAY COUNT=240 0.03 ms, YEARLY
      COUNT=50 0.02 ms — the library's COUNT query plan (since 2.2.3, not
      2.1 as the note said) jumps to the window. The shapes without a
      plan walk from DTSTART, capped at 10k periods: plain MONTHLY
      COUNT=240 (what our repeat picker writes) 0.29 ms, WEEKLY
      BYDAY+BYSETPOS COUNT=2000 9 ms (rare). Revisit only if a profile
      shows expansion in a window read; the fix then is caching
      `RRuleTemporal` instances per master so the library's plan and
      `all()` caches outlive one read. The per-calendar "keep only N
      years" switch stays in `todo.md`: 303 events in 380 KB locally is
      no storage problem.

### Review fixes (2026-10-04)

The first seven Tier 0 items of the 2026-10-02 review, as separate PRs
(two shared `updateRecurring`, so they went together). Each fix came with
a failing test first.

- [x] A series keeps its kind; edits before the create lands — #110
      (`todo/recurring-edit-fixes`). The all-day switch on an occurrence
      built UTC-midnight times but never sent `isAllDay`: "This event"
      wrote a timed 24 h block at 00:00Z, "All events" shifted the whole
      series by that delta, all-day → timed was dropped. Decisions: **the
      switch is refused, not supported** — Google keys occurrences and
      exceptions by date or date-time to match the series, so a real
      switch is a new series and needs a live-verified design. Refused
      in `updateRecurring` (`RecurringAllDaySwitchError`, Google and
      Apple), the editor model (`recurringTimesError`) and the UI
      (`canSwitchAllDay`: the switch is disabled on an existing repeating
      event); the agent gateway already had the rule. **An all-day series
      moves one occurrence at a time** (`RecurringAllDayMoveError`): the
      Google path compares against the date the occurrence shows (its
      exception's, else its slot's); Apple slots are device-local
      midnights, so there only the editor and the agent refuse. A
      series/following edit, or a following delete, of a series whose
      create had not reached Google replaced the create with a PATCH that
      404'd, and the NotFound arm deleted the series locally. **The edit
      folds into the queued create**, which keeps its `createdAt`; a
      series delete of it queues nothing; a split truncates inside the
      create and queues no instance deletes; text is not carried onto
      exceptions Google does not have yet. **Occurrence edits and RSVPs
      wait for a create queued ahead in their series** (`applyOp`, the
      same hold as for moves). **Only a never-sent create is folded into
      or dropped** (review of #110): an insert that landed with its
      response lost stays queued, and its retry's 409 counts as done
      without sending a folded edit. `applyOp` stamps an event create as
      dispatched before the insert (as for tasks); behind a sent create
      the PATCH or DELETE queues as before and waits for it. `updateEvent`
      and `deleteEvent` follow the same rule for single events. A
      create's response no longer overwrites its row while a later op of
      the event is queued — it would restore an edited or deleted event.
      A create the token never let out is stamped too (the stamp is set
      before the request): the edit then queues behind it, one request
      more than needed, never one too few.
- [x] A newer task edit of another field keeps the queued one's — #111
      (`todo/task-edit-merge`). "Latest wins" removed the queued
      `updateTask` while an op carries only the fields its edit changed:
      rename, then a new due day, sent only the day and the response
      reverted the title. Decision: latest wins field by field — still
      one patch per task in the queue.
- [x] Read-only calendars: events there neither drag nor change — #112
      (`todo/readonly-calendar-writes`). A dragged event in a reader
      calendar got a 403, the op was dropped, and the drop marked the
      moved row synced. Decisions: **the mutation layer refuses**
      (`writable` around update/delete in both providers, and moving or
      converting out of such a calendar) with the existing
      `CalendarNotWritableError`; a calendar with no row passes. Both
      apps stop the drag before it starts (`useEventReadOnlyLookup`); the
      block still opens the viewer. Desktop: a press on a block that
      cannot move now captures the pointer — without it the release
      landed on the grid as a click on an empty slot.
- [x] Removing a Google account asks first — #113
      (`todo/confirm-account-removal`). Decision: only a Google account
      asks (`removeAccountQuestion`), naming the account and how many
      unsynced changes would be lost; an Apple account only disconnects
      (EventKit keeps everything, reconnecting is a tap) and still goes
      on one tap — the five Maestro flows that remove one are unchanged.
      `PendingOpSummary` carries `accountId` for the count. **Remove waits
      for a successful queue read** (review of #113): `usePendingOps`
      falls back to `[]` while loading or after a failed read, which read
      as "nothing unsynced"; `usePendingOpsRead` keeps 'loading' /
      'failed' (a failed refresh included — the last count may be stale),
      the desktop button stays disabled until the read lands, and the
      iOS alert, which cannot update once shown, offers only OK until
      then.
- [x] Agent text that would pass an approval unseen is refused — #114
      (`todo/agent-hidden-text`). The summary dropped invisible
      characters while the write kept them, and tag characters were not
      even dropped: a sentence could ride in an event's notes to every
      guest. Decisions: **refuse, don't strip** (`hiddenCharacter`, in
      `checkText`, the former length-only `within` every free-text field
      already went through): control characters other than line breaks
      and tabs, and every default-ignorable code point. **A joiner or
      variation selector only inside a complete emoji** (review of #114:
      `\p{RGI_Emoji}`, Unicode's recommended sequences): a joiner between
      pictographs that form no emoji draws as nothing, and its presence or
      absence spelled "PIN=1234" between visible apples. The summary keeps
      complete emoji whole, so it shows the family emoji the write holds.
      The pattern is built with `new RegExp(…, 'gv')` — a `v` literal needs
      an ES2024 target; the agent runs only on Node and Electron. Tabs
      show as a space in the summary. Invitation text keeps being stripped
      for display.
- [x] Repeat until ends in the series' own zone — #115
      (`todo/repeat-until-zone`). `UNTIL=<date>T235959Z` lost the last
      day west of UTC and added one east of it. Decision:
      `buildRecurrenceRule` takes the series' zone and writes the last
      second of the chosen day there (start of the next day minus one
      second, safe across a midnight DST change); all-day keeps the DATE.
      The read side (`parseUntil`, `lastDayOf`) already read UNTIL in the
      series' zone.

### Review fixes, second batch (2026-10-05)

The next items of the 2026-10-02 review, grouped by the code they share
into five PRs so none conflicts with another; each fix came with a
failing test first. All five also carry one identical commit that made
main typecheck again: #112's read-only test put the mutations' effects in
one array, and #110's `RecurringUpdateError` broke its inferred type once
both had merged.

- [x] CI minutes and Dependabot — #117 (`todo/ci-minutes`). The change
      classifier reports `desktop` and `ios` instead of one `code` flag: a
      change only under `apps/ios/` skips the desktop jobs, one only under
      `apps/desktop/` or `packages/agent/` skips the iOS e2e; shared
      packages, root config, the lockfile, workflows and `brand/` run
      both, and `apps/ios/assets/` also runs packaging smoke (it checks
      the brand exports there). Desktop e2e waits for the gate. An iOS
      label run has its own concurrency group (it cancelled the push's
      OTA preview) and runs the gate only for `testflight`; another label
      on a `google-live` PR no longer reruns the live suite. Dependabot's
      weekly group holds only what can merge as is — majors, vite-plus
      with vitest, and minors of the Expo-bound React Native stack are
      the deliberate sweep's. An iOS e2e shard may run 45 minutes (green
      ones take 25–34, half of it setup; at 35 a slow runner was cancelled
      two flows short). Flow 07 retypes a title XCTest garbled, and flow
      21 counts any mirrored events, since a flow that failed before its
      clean-up leaves its event behind.
- [x] Sync queue integrity — #118 (`todo/sync-queue-integrity`).
      **A response writes its row only while no later op of the event is
      queued** (`settleRow`: create, update, RSVP, move) — the guard #110
      added for creates, shared. **An update that lands moves the queued
      ops built on the etag it sent to the etag it produced**
      (`advanceBaseEtag`): Google checked that etag, so nothing else
      changed in between; an RSVP moves nothing (no If-Match, Google's
      prior state unknown). The row a later edit still holds moves too
      (`advanceEtag`), so a third drag that replaces the second starts from
      the new etag (review of #118). Every ack settles in one transaction
      with its queue check (`settle`). **A 412 is done only when Google's
      copy yields exactly the PATCH body the update would send**
      (`updateBody` from both): a lost response's retry; any difference
      still parks — and its followers keep their etag (review of #118: the
      match covers only the fields this update sends, so a follower moved
      to the new etag overwrote another client's reminders unasked). **A
      create answered 409 fetches the event** (or drops the row if Google
      has none) instead of leaving it `pending`, checking the queue again
      after the fetch. **Queue cleanup is scoped
      by account** (a shared calendar repeats its ids). **A sync the user
      caused makes waiting ops due** (`SyncEngine.syncNow`: wake, focus,
      foreground, a reconnect; `retryNow` keeps the attempt count; the
      timed poll keeps the backoff).
- [x] Notification time zones — #119 (`todo/notification-zones`). The
      text ("Tomorrow 3:00 PM") is in the device's zone; an all-day
      reminder still counts from midnight in the calendar's zone, as
      Google's do. `LocalNotifications` reads the device zone on every
      pass (`timeZone: () => string`): the 2026-09-29 decision is "follow
      the device", and capturing it at startup was where it was read, not
      a choice. A zone the engine cannot load is read under its other
      spelling (`runtimeZoneId`, both ways round since the review of #119:
      Google can store a legacy name Hermes rejects, such as
      America/Buenos_Aires), else as the device's; an event that
      still cannot be planned is skipped, never the whole pass.
- [x] Untitled events, meeting hosts, one sync start — #120
      (`todo/small-verified-fixes`). **The placeholder stays in the
      record and is never written**: `UNTITLED_EVENT` is what both mappers
      read an untitled event as (the editors require a title, so an empty
      one would make it uneditable). Google gets an empty title instead —
      no change on an untitled event, untitled on an insert, and (review of
      #120) a remote title cleared when "keep mine" restores an untitled
      version; left out, Google kept its title and the response overwrote
      the user's choice. An empty summary reads back as untitled. EventKit
      gets no title (no conflict path there). Zoom and Webex links count
      only from the domain itself or a dotted subdomain. iOS `startSync`
      runs once per process.
- [x] Desktop hardening — #121 (`todo/desktop-hardening`). **The CSP
      does reach the packaged app's `file://` page** (an inline script is
      blocked; the review doubted it, and an `eval` probe misled: CDP's own
      evaluation is exempt from a page's eval rules) — **so it blocked
      dictation's `blob:` worklet**, and dictation worked only from source.
      The worklet is `public/pcm-collector.worklet.js` (copied next to
      `index.html`; not a `?url` import, which may inline as `data:`).
      Settings › Agents arms Decline/Approve 700 ms after the waiting list
      changes (keyed by the whole list: the row that slides up was mounted,
      and armed, long before). A ⌘K bar closed while dictation prepared or
      while the microphone was granted no longer turns the microphone on.
      **Each start owns what it opens**: `startRecording` takes an
      `AbortSignal`, the bar aborts its start on close, and an aborted start
      stops its own stream (review of #121: the adapters keep one shared
      recording, so the closed bar's late `cancelRecording()` stopped a
      reopened bar's). A new recording stops the one it replaces when it
      commits.

### Review fixes, third batch (2026-10-05)

Four more Tier 0 items of the 2026-10-02 review, one PR each, grouped so
none conflicts with another; each fix came with a failing test first,
except where a test cannot fail on Node (noted).

- [x] Save once — #124 (`todo/save-once`). **One write at a time per
      editor**: Save and Delete run through one slot (`useOneWrite`), and
      a press while a write is in flight starts nothing; a second tap
      used to create a second event or task. The slot is a ref set
      synchronously, so two clicks in one tick count once (desktop e2e).
      `busy` only dims the buttons: disabled, a button came back on the
      next render only, and CI's convert e2e showed a press right after a
      declined confirmation landing on it and doing nothing.
- [x] Queue leftovers after #110 and #118 — #125
      (`todo/queue-leftovers`). **A sent create stays in its calendar on
      a move** (`googleServerMove`), with the move queued behind it: it
      may have landed there, and re-keyed into the destination its retry
      inserted a second copy. **A 410 on a write is "gone", like a 404**
      (failForStatus reads every 410 as an expired sync token; taken as
      done, the row stayed pending for good). **Losing the tasks scope
      drops the op through `drop`**, which releases the row and tells the
      UI. **An RSVP sends If-Match** on the etag it was queued against:
      when that holds, the edits built on it move to the etag it produced
      (an edit right behind an RSVP no longer parks against it); a 412
      resends it unchecked — an RSVP never loses to an unrelated edit —
      and moves nothing. **Only ops queued after the one that landed
      follow its etag** (review of #125: an RSVP that overtook a guest-list
      edit in backoff moved it too, and the edit then undid the RSVP). **A
      delete answered 404 or 410 is done and keeps the local state**: for
      an occurrence that is the cancelled override, whose loss brought the
      occurrence back. **Dropping a create drops a move queued behind it**
      and the rows it put at the destination, which the move's 404 would
      have put back in the source as synced.
- [x] Event zones and repeat ends — #126 (`todo/event-zones`). **A pulled
      event without a zone takes its calendar's** (the zone Google sends
      with each page, then the stored calendar's), not UTC. **Zones are
      spelled for the engine where events come in and where rows are
      read** (`engineZoneId`, `engineRecurrenceLines`: the start zone and
      every TZID): Hermes rejects `Asia/Kolkata`, and such a series was
      left out of every iOS view; decoding covers rows stored before. A
      zone known under no spelling stays as it was. Node knows every
      spelling, so iOS flow 24 (a fixture series in that zone) is the
      only check on the engine that rejects it; its series is anchored to
      noon on the simulator's today (review of #126: a UTC anchor missed
      today where the local date differs). **A repeat end before the
      first day** is read by quick-add as next year's ("until March" in
      October), dropped if still before; the editors refuse one
      (`repeatUntilError`) and the until pickers start at the first day.
- [x] Desktop robustness — #127 (`todo/desktop-robustness`). **A page
      leaves as an rpc client when its new document says so**: the
      preload sends `rpc:document` before any rpc frame (⌘R; a hash change
      runs no preload, so the Settings panes stay one client). Not on
      did-start-navigation (review of #127): it fires before main.ts's
      will-navigate refuses a navigation, and a refused one keeps its
      document — and must keep its streams. The review's
      "stops receiving invalidations" did not reproduce — the reloaded
      page reuses the old stream's request id and gets its batches by
      accident — but every reload leaked that stream, and the server
      drops a new request whose id is still running, so a query could
      hang. **A helper timeout fails that request alone** and sends a
      `status` probe; only a probe that times out too kills the helper.
      The helper runs each request in its own task, so a slow MapKit
      search no longer takes a pending permission prompt or a
      transcription with it.

### Review fixes, fourth batch (2026-10-07)

The rest of Tier 0's sync items and three groups of the review's Tier 2
UX list, one PR each, grouped so none conflicts with another; each fix
came with a failing test first.

- [x] Deletes ask first — #129 (`todo/confirm-delete`). **Confirm, not
      undo**: an undo would hold back the Google delete op and fake the
      row's absence, and an Apple delete leaves EventKit at once. Both
      editor models ask (`EditorConfirmRequest` kind `delete`) before any
      write, inside the write slot, naming what goes (`deleteQuestion`:
      the title, and for an occurrence of a series how much of it).
      Desktop asks inline (Keep / Delete, test ids on the buttons), iOS
      in an Alert (Cancel / Delete).
- [x] Desktop dialogs — #130 (`todo/dialog-escape`). **One stack of open
      dialogs; only the topmost (highest zIndex, then the last opened)
      answers Escape and traps Tab** — stopPropagation does not stop
      another window listener, so one Escape closed them all. Escape
      stops with stopImmediatePropagation (review of #130): for a native
      key React commits the closed dialog's unmount between listeners,
      and the next one found itself on top. The
      calendar's keys and its paste stand back for any dialog
      (`isDialogOpen`), the agent approval App opens included; ⌘K opens
      its bar over none.
- [x] Sync leftovers — #131 (`todo/sync-leftovers`). **A calendar-list
      410's full relist purges** (the pass knows it ran in full). **A
      malformed `updated` reads as the sync time** instead of failing the
      calendar's pass. **An unreached request (no status) gets one retry,
      not five** — offline held the sync gate half a minute per account;
      5xx and 429 keep five. **`listForEvent`** filters the queue in SQL
      for every edit and ack. **One fn atom per mutation call**
      (`runMutation`): Atom.fn runs latest-wins, so a second quick call
      interrupted the first and both read its result.
- [x] Sign-in — #132 (`todo/sign-in-feedback`). **The desktop's browser
      tab is answered once the outcome is known** (after the code
      exchange; state checked first, reason escaped). **Cancel** stops a
      sign-in waiting on the browser (`auth:cancel` preload IPC — no
      calendar data, so not rpc). **A cancellation is no error**:
      `SignInCancelledError` (sheet dismissed, `access_denied`, Cancel)
      crosses as BackendError's tag and neither app nor the mutation
      toasts show it. **`addAccount({ loginHint })`**: a reconnect sends
      `login_hint` with `prompt=consent` only, so Google opens on that
      account.
