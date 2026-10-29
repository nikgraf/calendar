# Decision log

What was decided when each shipped item landed: the choice, the
alternatives rejected, what it left open, and the PR or branch for the
detail. Grouped by area, dated inside each record. This is history — the
current state is `docs/architecture.md`, the rules are in `AGENTS.md`,
and the mechanism of anything here lives there, not in this file. A new
record is ten lines at most (see the workflow rule in `AGENTS.md`).

## Product and distribution

- **App name Solunivo** (2026-08) — no trademark hits, solunivo.com
  bought; latent sol+luna+novo reading. Bundle ids `com.solunivo.desktop`
  and `com.solunivo.app`; the internal `@calendar/*` package scopes and
  the GitHub repo name were deliberately kept (#23).
- **macOS distribution** — a signed + notarized arm64 zip as a CI
  artifact on every main push (`docs/distribution.md`). No universal
  build (Intel Macs are outside the target group), no GitHub releases, no
  auto-update while the repo is private (`update-electron-app` is wired
  and inert — update.electronjs.org serves public repos only), crash
  reporting off (privacy posture). The testing build embeds the RFC 8252
  desktop OAuth client from a secret-fed file.
- **iOS distribution** — EAS Build + TestFlight on native changes,
  otherwise an OTA update, decided by the native fingerprint; every PR
  gets a `pr-<n>` OTA channel loadable in-app; the `testflight` label
  ships a real build for a native PR. No per-PR TestFlight builds by
  default (cost and latency).
- **PR preview channels** (2026-10-20, #229) — `eas update --branch pr-<n>`
  made only a branch, so the app's channel request answered 404 and no
  PR preview had ever loaded; `--channel pr-<n>` creates a missing
  channel on a same-named branch (rejected: `channel:view ||
  channel:create` before `--branch`, two calls for one). Closing the PR
  deletes the channel, then the branch, unless the channel holds a build
  (it would go too). PR runs' concurrency is keyed on the number: a merged
  close's `github.ref` is main. Older closed PRs' 188 branches were
  deleted by hand (2026-10-21). Open: `--channel` follows a channel
  repointed by hand; a PR closed with a merge conflict gets no run.
- **PR Preview page** (2026-10-21, #231) — Load kept the override when
  nothing loaded and said to force-quit, but short of a rollback
  expo-updates reports nothing new when the PR has nothing for this
  runtime newer than what runs, and a restart fixes neither. Load now restarts,
  says the PR runs, or puts the previous channel back and says why; Back to
  Main restarts unless main runs. The page names the running update's
  branch (`metadata.branchName`) and tracks the chosen channel itself,
  since `Updates.channel` is read at launch and Back to Main can change it
  without one. Open: `MAIN_CHANNEL` copies eas.json's testflight channel.
- **Production and dev side by side** (2026-10-01, #100) — the real
  accounts live in the production app, test accounts in a dev variant
  next to it, on the Mac (a run from source) and on the phone
  (`com.solunivo.app.dev`). **Two variants, not three**: no separately
  packaged desktop dev app and no "beta" app in App Store Connect (a
  second record and update channel, and the binary tested would no longer
  be the one shipped). `APP_VARIANT` unset means production, so a release
  job that forgets it cannot ship the dev identity, while a dev consumer
  that forgets it fails visibly. `app.config.js` is plain CommonJS: a
  `.ts` config is transpiled with Babel on every manifest request, which
  pushed the dev client's first request past its 10 s budget on CI. Apple
  data is not separated by nature; withhold the permissions from the dev
  app or start a dev run with the `CALENDAR_*=off` switches.
- **Onboarding** (2026-10-22, #238) — accounts first in a setup you can
  skip at every step (Welcome, "What do you use?", one screen per ticked
  source; on the Mac one dialog over the calendar), then a "Getting
  started" card whose six rows are lessons tried in the real surfaces, and
  Settings › Getting Started. Google Calendar and Tasks share one sign-in;
  the Tasks box only decides the tasks scope. State is per device, never
  in the settings document. Rejected: the empty state alone (explains
  nothing), a full wizard before the app, the card without a setup.
  Open: mirrors stay out of the lessons.
- **Settings code** (2026-10-24, #243) — a setup copied between iPhone
  and Mac by a QR of the settings document: in-app text `SOLUNIVO:1:` +
  base32 of deflate-raw, without what an import never reads. Base32 over
  base45 (spaces, `%`, `+` break in pastes) and base64 (QR byte mode, 2–4
  versions larger). The Mac reads by camera through the helper's Vision
  (Electron 44 has no `BarcodeDetector`) and by paste; iOS by expo-camera
  and paste, the QR a PNG (no react-native-svg). Shown behind Show Code; a
  pasted code never reaches the AI. Rejected: LAN pairing, iCloud or
  Google storage, Handoff, a universal link. Open: Camera's "Open in
  Solunivo", the webcam on dense codes, parked Google prefs untitled.
- **Versions** (2026-09-11) — the apps are `0.1.0` with a CHANGELOG;
  bump together when a release is worth a number.
- **Schema baseline** (2026-09-15, again 2026-10-15) — the pre-release
  migrations were collapsed into one, twice, since nothing had shipped;
  the second pass also dropped every upgrade of old data (zone lists
  without the device entry, the old fired map and Keychain key, the
  Birthdays purge). The runner refuses rather than self-wipes: an applied
  row whose id and name this build does not know dies naming
  `pnpm reset:local` — names, as ids are reused after a collapse, so a
  migration is never renamed. Leaves open: every existing install resets
  once. Schema changes are appended migrations again.

## CI and dependencies

- **CI shape** (2026-09-11) — one reusable `gate.yml` called by both
  workflows (GitHub cannot `needs:` across workflow files); docs-only
  changes skip the macOS jobs through `if:` guards, never `paths-ignore`
  (required checks would go unreported); later (#117) the classifier
  splits `desktop` from `ios` so a change under one app skips the other's
  jobs. One retry per desktop e2e spec. Maestro pinned with a sha256,
  `pnpm/action-setup` SHA-pinned, Dependabot for actions and npm with a
  weekly group holding only what can merge as is.
- **Real EventKit on CI** (2026-09) — the desktop helper runs against the
  runner's Reminders and Calendars with a seeded TCC grant and a hard
  fullAccess probe; iOS runs against a simulator with `simctl privacy
  grant`. Hard failures, not skip-with-warning: a broken TCC seed must be
  seen. The strict specs are CI-only siblings of the tolerant local ones.
  First catch: the helper's main thread sat in `readLine()`, so
  `EKEventStoreChanged` had never fired on desktop.
- **Packaging smoke on PRs** (2026-09) — an unsigned `package:app` on
  every code PR, after two packaging failures surfaced only post-merge;
  `brand:check` runs there too, the one macOS job every code PR pays for.
- **iOS e2e without Metro** (2026-10-05, #117 and later) — CI drives the
  dev variant as an `e2e-simulator` Release build with the commit's JS
  repacked in, two shards; with the dev client a run took 49 minutes,
  18 before the first flow. The dev client with Metro stays for local
  runs and the live suite.
- **Flow branches on script flags** (2026-10-14, `todo/maestro-flow-flags`)
  — a `while`/`when` condition gets up to 7 s to come true, so the flows'
  "sheet still open?" clean-ups after a save (07, 08, 09, 12, 17, 22),
  06's quick-add outcome check, 07's notes retype and the dismiss loops
  in 20 and 22 waited 5–8 s each on CI's path, over a minute per run. The
  branch that ran now sets an `output` flag the other is keyed on; a loop
  is `retry` + `extendedWaitUntil` on its effect. Rejected: flipping the
  conditions (a condition false on the common path waits either way).
  Open: 22's stacked-alert retry ran only on a stand-in (the simulator
  stopped showing the alert).
- **Quick-add phrases retyped** (2026-10-15, `todo/quick-add-retype`) —
  XCTest typed flow 06's `| | 20:00-21:00` as `|0-21:00` (run
  38734567429), and the app read what it got: 00:00–21:00. Each phrase
  now goes through `common/apply-quick-add.yaml`: type, compare the
  field's value as a string, erase and retype until it matches, then
  Apply. Rejected: an `extendedWaitUntil` regex like 03 and 07 (the
  phrases' `|` would need escaping in every pattern).
- **Dead Maestro driver retried** (2026-10-14, #205) — when the XCTest
  driver dies mid-run, Maestro fails every later flow in that invocation as
  unreachable; `run-flows.ts` runs exactly those flows once more on an
  erased simulator (a cut-short flow leaves state in the app and in
  EventKit). Only `DeviceUnreachableException` with the latch in the run
  log qualifies; a flow failing on its own blocks the retry, so an app race
  still turns the job red. Rejected: a blanket rerun like desktop's
  per-spec retry, and Maestro's `retry` command (it retries assertions and
  cannot outlive the latch). Simulator prep turns keyboard predictions off
  and boots out apsd's log flood. Open: whether the keyboard hang gets rarer.
- **Maestro driver that never starts** (2026-10-22) — four shard-1 runs
  failed before any flow: Maestro gave up on its XCTest runner while
  opening the session and wrote no report, so #205's retry never applied.
  `run-flows.ts` now copies Maestro's console to `console.log` and runs
  every flow once more when the timeout's stack passes session creation
  (`createMaestro`); the runner also gets 240 s
  (`MAESTRO_DRIVER_STARTUP_TIMEOUT`). Rejected: a retry for any missing
  report (only session creation proves no flow ran), and the longer
  timeout alone (an XCTest that never initializes still fails). Open:
  whether the cold-runner case returns.
- **Flow 06's sheet drag off the bottom edge** (2026-10-29,
  `todo/editor-sheet-drag-race`) — the drag that raises the half-height
  editor started at 93 %, inside SpringBoard's bottom-edge gesture region:
  the app's pan waited on its cover-sheet edge pan's answer, which took
  up to 0.4 s on CI, longer than Maestro's 0.1 s move, so three runs left
  the sheet at half. It now starts on the title (84 % → 51 %). The app
  was ruled out: every failed pan began with the form at its top, and the
  wait was SpringBoard's. Rejected: a retry while the grabber reads "Half
  screen" (it would pass a sheet that rises only now and then). Open: a
  real finger near the bottom edge meets the same wait, unmeasured.
- **iOS e2e without MapKit** (2026-10-15, `todo/ios-geo-off`) — CI's bundle
  sets `EXPO_PUBLIC_CALENDAR_GEO=off`, the desktop's `CALENDAR_GEO=off`:
  flow 22's "Room 4" was geocoded live on every run (once to a place named
  "Room 55"), and the editor's live map was the likely cause of a 16 s
  hierarchy read. Rejected: hiding the map from accessibility — the SwiftUI
  map's streets and pins stay in the tree under `accessibilityElementsHidden`
  and `collapsable={false}` (probed locally). Open: what VoiceOver makes of
  those elements, and an open-time lookup of free text mapping the wrong place.
- **Test pruning** (2026-10-09, `todo/prune-tests`) — a test goes only
  if a surviving test asserts everything it did; iOS flows are merged per
  area, not dropped, because a launch or a Reminders connect repeated
  across flows is the cost worth cutting (CI shards spend ~16 minutes on
  setup and are billed macOS minutes). Not done: table-driven merges of
  near-identical unit tests, shared test helpers.
- **Maestro helpers without condition waits** (2026-10-13,
  `todo/maestro-helper-waits`) — a `while`/`when` condition gets up to 7 s
  to come true, so each re-tap/retype loop paid that on a successful exit
  and await-shell's guards ~5 s per launch. Now `retry` + `extendedWaitUntil`
  on the effect, script flags where the common path branches; recovery
  paths kept and fault-injected. The idle had hidden two races: the
  header's late top inset (now proven: `today` below the status bar's
  clock, 12- or 24-hour) and a launcher-row tap racing the dev client's
  own reopen. Rejected: a fixed settle delay after launch. Open: the
  slide-to-type card and the dev menu's onboarding never showed locally.
- **Dependencies** (2026-09-14, 2026-10-09, 2026-10-03) — every sweep is
  one commit per group, each droppable. `effect*` exact (the pin stays
  exact on 4.x: rpc, sql, http and reactivity are `@stability unstable`),
  Dependabot ignores them; the deep SQL imports stay deep for Metro. React
  is held to the React Native renderer's version with tilde ranges (a
  caret once let the lockfile resolve past it); the Expo-bound RN stack
  moves only with the SDK. Vite+ 1.1 brought Vitest 5, `vp pack` for the
  main bundle and tests importing from `vite-plus/test`; vitest must equal
  what vite-plus bundles. The 2-day release-age gate is never bypassed
  (stable Effect was waited out); Expo SDK 57 patches are trust-excluded
  by exact version after an audit (`pnpm-workspace.yaml`).
- **QR encoder** (2026-10-25, `todo/qr-library`) — the settings code's QR
  comes from paulmillr's `qr`, not `uqr`: actively maintained, no
  dependencies, and the same version at every code length (v1–v40, both
  refusing past 3391 characters); at 79 of 3381 lengths the mask differed,
  nothing else. About 3 KB gzipped more. Unused: its GIF
  and SVG output (the 1-bit PNG is far smaller) and its decoder (Vision
  and expo-camera read the code).

## Architecture and sync path

- **Effect-first** — I/O, orchestration and validation are Effect
  services and Layers; pure math and React are plain TS. UI state is
  `@effect/atom-react` over Reactivity keys; the backend seam is an
  `effect/rpc` group (`AppBackendRpcs`) with custom duplex protocols over
  Electron IPC (a MessagePort transport is a drop-in swap) and a typed
  invalidation stream, replacing a hand-rolled Schema-typed IPC bridge.
  The rpc plumbing is derived: adding a method is the `Rpc.make`, its
  handler and a reactivity-keys entry — everything else follows or
  type-errors.
- **Migrations** — a hand-rolled runner (effect's `Migrator` is
  Metro-incompatible), each migration transactional with its bookkeeping
  row, duplicate-id, climbing-id and identity guards (an applied row must
  match a known id and name) that die loudly.
- **Op queue invariants** (2026-09-11 sweep, #110, #118, #125) — the
  local write and the queue change commit in one transaction, with the
  drain kicked after commit (`Effect.suspend(forkDetach)` so a failed
  transaction never starts a drain); pulls skip rows with a queued local
  edit; a permanent rejection drops the op _and_ announces it; a row
  whose payload no longer decodes is quarantined by being skipped (no
  payload version tag — the schema is the tag); a response writes its row
  only while no later op of the event is queued; an update that lands
  moves its followers to the etag it produced, an RSVP only when its
  If-Match held; a 412 is done only when Google's copy yields exactly the
  PATCH body; only a never-sent create is folded into or dropped; a sent
  create stays in its calendar on a move; a 410 on a write is "gone".
- **Full event history** (2026-09-14) — the events pass sends no
  `timeMin`: one unbounded first pass rather than a quick window plus a
  background backfill (Nik chose the simpler shape; pages land
  progressively and Settings explains the wait). `recurrence_end_utc`
  bounds the masters query so ended series are never expanded. The
  per-calendar "keep only N years" switch stays in `todo.md`.
- **RDATE and COUNT series** (2026-10-04, #109) — no RDATE parser of our
  own: an RDATE-only set gets `RRULE:FREQ=DAILY;COUNT=1` and the library
  does the rest; DTSTART is always an occurrence, listed as an RDATE too
  (Google draws it even on a day the rule skips, outside COUNT — probed
  live). Long COUNT series were measured and left alone; revisit only if
  a profile shows expansion in a window read.
- **A master edit reaches the exceptions** (2026-09-26, review of
  #88/#90) — Google copies a master's _changed_ title, description or
  location onto every exception, so the app mirrors that at save as a
  projection of the queued op, storing Google's master text and each
  exception's own (nothing could be recomputed otherwise); discard,
  take-theirs and a permanent rejection restore the exceptions.
- **Conflicts with a choice** (2026-09-23, #85) — a 412 parks the op
  instead of dropping it (server-wins deleted the user's version and lost
  server changes a pull had skipped). Show Google's version, not just the
  title (Nik's pick); the stored copy is a preview and take-theirs
  re-fetches live; keep-mine re-sends without If-Match (the user saw the
  comparison); an edit of an event Google deleted is restored under a new
  id; a parked op survives a move. The old `notice:conflict` toasts are
  gone.
- **A gone calendar** (2026-09-29, #96) — a 404 from one calendar skips
  it for the pass and drops the calendarList token so the next pass lists
  in full; purging on the 404 was rejected in review (Google says to retry
  404s, and a delta never brings an unchanged calendar back).
- **A gone calendar's purge is Google's timing** (2026-10-22, #235)
  — `calendarList.live.ts` red on 3 of 15 nightlies: the calendar's events
  never 404'd in three minutes, so nothing told the engine to relist. The
  test polls six minutes, then skips while Google still lists the calendar
  or serves its event. Rejected: a longer budget alone (the lag has no
  known bound), a full calendarList every pass (lagging replicas list it).
- **Re-auth and sync kicks** — a 401 flags the account `reauth_required`
  and keeps its ops queued for after the reconnect (same id, by email);
  wake/unlock/focus/foreground kick a sync, throttled to one per 15 s,
  and a user-caused sync makes waiting ops due at once (#118).
- **Overrides scoped to their master's account and calendar**
  (2026-09-10) — event ids are Google-global, so two accounts on one
  shared calendar carried same-id masters and one account's exception hid
  the other's occurrence.
- **Adapter drift** (2026-09-11) — the bridge client factories and
  `finishAddAccount` live in the packages; iOS gets no `CALENDAR_*=off`
  switch by design (its e2e runs against the real bridges), while the
  `EXPO_PUBLIC_CALENDAR_GOOGLE/MODEL=fixture` bundle flags swap a JS-level
  fake for a remote API and leave every bridge real.
- **Desktop hardening** (2026-09-11, #121, #127) — a CSP outside dev
  (which reaches the packaged `file://` page, so a `blob:` worklet had to
  become a public file), `will-navigate` and window-open allow-lists,
  bounded `model:*` payloads, atomic settings writes; a reload
  re-registers the page as an rpc client (`rpc:document`, not
  did-start-navigation, which fires before a refused navigation); a
  helper timeout fails that request alone and probes before killing.
- **Settings as a file** (2026-09-30, #97) — a versioned
  `SettingsDocument` with Export/Import on both apps and the desktop's
  watched `~/.solunivo/solunivo.jsonc`. The document never holds tokens
  (the platforms use different OAuth clients anyway, and a desktop refresh
  token is a non-expiring bearer); an unknown Google account imports as
  `reauth_required`; an import never removes anything and never connects
  an Apple provider (no TCC prompt from a file); accounts are keyed by
  kind + email since both Apple accounts share `provider: 'apple'`. The
  file is opt-in ("Create file" in Settings) — auto-creating it would put
  account emails in a dotfolder nobody asked for and switch the two-way
  mirror on for everyone; a symlinked file is written at its target; a
  periodic stat is the source of truth and directory watchers only the
  fast path (watching the home directory was rejected: noisy). Rejected:
  iCloud key-value sync of the document.
- **Unsynced changes diff and revert** (2026-10-10) — a queued op keeps
  the row it replaced (`before*` columns, inherited across coalescing, so
  the diff is always against what Google last acknowledged); the list's
  rows expand to the diff and the discard action lives only there,
  and discarding — like a permanent rejection — puts the row back instead
  of marking the edit synced. The diff ships as display lines computed in
  the handler, not as records. Rejected: a server-copy column on
  events/tasks (every pull would write it), a per-op detail rpc, and
  whole-row restore — four Codex rounds showed a discard resurrecting
  another change discarded meanwhile, a landed one, a pulled color or a
  remotely deleted item: an op puts back only the fields it owns (and
  takes them out of the other queued snapshots and payloads), a landed
  op moves every queued snapshot of the item, a confirming pull clears a
  delete's, a superseded op refused in flight puts nothing back. Open: a
  deletion a full re-list confirms only by absence clears no snapshot; a per-item
  acknowledged copy would replace the per-op snapshots if more
  interleavings turn up.

## Calendar: editing, gestures, views

- **Editing keeps an event's span** (2026-10-13, #200) — the event form
  has an end date (Starts/Ends rows, both apps) and an update leaves
  untouched times out, so a title edit no longer cut a multi-day all-day
  event to one day or refused an overnight one; a this-and-following
  split still sends the times shown. Rejected: inferring the end day
  from the times alone, which cannot say how many days an all-day event
  spans.
- **Save sends only what changed** (2026-10-14, #208) — the event form
  diffs title, notes and location against what it opened with, as the
  task form already did, so an agent's or another device's edit made
  while the form was open survives a title change; the kind goes only
  with the times and an untouched Save writes nothing. Rejected: diffing
  against the live row (an untouched field would read as changed once
  sync moved it) and re-seeding the open form (loses what is typed).
  Open: a split from an exception no longer carries its own notes into
  the new series; the series' text continues instead.
- **Drag to move and resize** — pointer drag on desktop, long-press pan
  plus a resize handle on iOS, shared snap math in core; gestures track
  input 1:1 and snap on release — Nik rejected discrete-step snapping
  everywhere (the trackpad pan eases to the nearest day only when the
  wheel goes quiet). All-day chips and the month view do not drag.
- **One pan per iOS event block** (2026-10-15, #216) — move and resize
  share one long-press pan; where the touch goes down picks which (the
  bottom 16 pt resizes, as the handle's hit test did). The bottom edge's
  own pan and the block's pan waiting on it both started, since RNGH
  reports a long press active before UIKit lets a waiting pan begin;
  when the block's started first it was failed later and never
  finalized, so the block stayed lifted and took no drag until a
  relaunch. Rejected: keeping two pans behind an owner guard (the
  missing finalize is RNGH's, out of the app's reach).
- **Drops land where they are drawn** (2026-10-25, #250) — a move or
  resize shifts by the wall clock in the grid's (primary) zone, not the
  event's own, keeping its offset through a repeated hour. Across a DST
  change in only one of the two (a Vienna event on a UTC grid) the
  event-zone rule stored it an hour from its row. Adding days and minutes
  apart also fixed diagonal drags (a day right, an hour up) throwing for
  events with a zone and for timed reminders. Rejected: keeping the
  event's wall clock and drawing the preview with it (the block would land
  on a row nobody picked). Open: a series shift stays in the series' zone.
- **A series shift carries seconds** (2026-10-25, #253) — a time edit
  with scope "All events" moves the series by the occurrence's wall-clock
  delta, seconds included, so a series at 09:00:30 retimed to 10:00
  starts at 10:00. Before, the fractional minute threw and the edit
  failed. Rejected: keeping the series' seconds and shifting whole
  minutes (it would start at 10:00:30, a time nobody picked).
- **Recurring editing** — scopes instance / series / following; an
  instance edit materializes an exception under Google's canonical
  instance id so the later pull upserts idempotently; following truncates
  with UNTIL and spawns a new master; the editor seeds repeat fields from
  the master (`getEvent`), and a series can change or drop its rule, which
  drops its exceptions as Google does (#135). Custom BYDAY came later
  with the by-day rules (below). Dragging an instance commits an
  instance-scope override.
- **Drag to create** (2026-09-16, #69) — desktop draws with a press and
  drag on empty grid space, a click under the threshold still opens the
  hour; iOS keeps a plain drag for scrolling, so creating is a 300 ms hold
  that shows a one-hour slot stretched by dragging (Apple Calendar's hold
  default, stretched instead of moved, Nik's choice). The slot is
  anchored where the finger touched down and only grows (review: holds
  near a quarter line opened shifted slots); a slot reaching midnight
  ends at 23:59 because the editor is same-day. Out of scope: auto-scroll
  at the grid's edges, slots across days, keyboard slot selection.
- **Overdue tasks on today only** (2026-09-20) — never also on the
  original day (Nik's pick over showing both); a dedicated
  `getOverdueTasks` rpc merged with the range query. **Drag tasks between
  the lane and the grid**: the drop is judged by where the pointer is
  released, the rules live in one pure function, and a Google task
  dropped into the grid is reported `unsupported` and snaps back — never
  a silent day-only move. **The all-day lane collapses** to three rows
  with "+N more", a device setting (`ViewPreferences`, typed, never
  syncs). Undated tasks show on today and a task completed late stays on
  its completion day (2026-10-02). Auto-scroll at the grid edge came
  later (next).
- **Drags scroll the grid at its edge** (2026-10-15, #215) — task chips,
  timed task blocks and event move/resize, both apps; drawing a new slot
  does not (Nik's scope). An edge arms only once the drag has been in the
  grid clear of it, so a lane chip entering through the top band or a
  block pressed near an edge never starts it. Every offset counts the
  scroll since the press, which also fixed a wheel scroll mid-drag
  dropping the block off by that distance. Rejected: a dwell delay before
  scrolling, and iOS blocks reacting to every scroll offset (a tick only
  while the edge scrolls). Open: slot drawing, paging days at the side
  edges, the speed (8 h/s at the edge) felt on a device.
- **Screen-sharing privacy** — the desktop window is excluded from
  captures by default; "Visible for 10 min" is runtime-only and fails
  closed on restart; "Always visible" persists. **The capture hint**
  (2026-10-11): a window left out of a screenshot or recording says so
  on screen, with the 10-minute pause one click away. The signal is the
  `screencapture` process every ⌘⇧3/4/5 runs (probed: the screenshot UI
  never activates, and the ⌘⇧4 crosshair has no window). Rejected: a
  toolbar indicator (always-on noise, #178), a stand-in window behind
  the main one, a Spotlight toast after the file lands. Third-party
  capture tools stay unannounced (#179).
- **Per-calendar colors** — optimistic local update, write-back through
  `calendarList.patch?colorRgbFormat=true` as a `calendarColor` op kind
  coalescing per account; invalid hex rejected, 4xx dropped.
- **Sidebar rows show and hide, Settings recolors** (2026-10-24, #245) — the
  whole desktop calendar row toggles, its swatch a square checkbox in the
  calendar's color (checked when shown). The picker moved to a well at
  the end of each calendar's row in Settings › Accounts: the swatch had
  opened it while only the name toggled, and it looked like a checkbox.
  Task-list rows already toggled whole and keep their round dot (a round
  dot with a check reads as a done task). Rejected: a right-click Color
  menu (no context menus in the app yet). iOS already worked this way.
- **Popovers and dialogs keep Tab inside** (2026-10-25, #252) — focus
  guards: an empty focusable stop on each side of the panel takes focus
  on its way out and hands it to the other end, so the browser still
  moves focus and a date field keeps its segment-by-segment Tab.
  Rejected: a keydown wrap at the last control (tried in #245: Tab in
  To's month wrapped to From) and letting Tab out, then pulling focus
  back on a timer (it showed outside the panel first). Popovers now move
  focus in and give it back like the dialogs; the color picker opens on
  the current color. Open: Shift+Tab that wraps onto a date field lands
  on its first segment — script focus cannot pick the last.
- **RSVP** — a dedicated `rsvp` op sending an attendees-only patch that
  survives content-edit coalescing; responding from an occurrence answers
  the series. It carries If-Match on the queued etag since #125 (so an
  edit right behind it follows), resent unchecked on a 412.
- **Join meeting** — `hangoutLink` or the conference video entry point,
  plus Meet/Zoom/Teams/Webex/Whereby URLs scanned from location and
  description; opened in the system browser.
- **Native text selection (desktop)** — body-level `user-select: none`,
  re-enabled for inputs and copy-worthy read-only text.
- **iOS week pages day by day** (2026-09-20) — the strip follows the
  finger across a drawn buffer of seven columns and commits the columns
  crossed; the week's headers pan in lockstep. **2 Days** (2026-09-28,
  #94) is the same timeline with two columns anchored on the focused day
  (as Apple's and Google's multi-day views), so it needs no state of its
  own. **Swipe jumps** (2026-10-10, #163): the strip is placed by React
  with the swiped pixel sum (no UI-thread lag reset racing the Fabric
  mount) and the all-day lane fits the visible page, interpolating
  mid-swipe. Not checked: a real device.
- **Multiple time zones** (2026-09-29, #95) — up to three, one primary
  that replaces the device zone for everything the UI draws (the roots
  gate on it rather than falling back: a first frame in the device zone
  near midnight would seed "today" wrong); the others annotate. A
  checked-in canonical IANA list, since Hermes lacks
  `Intl.supportedValuesOf`, and a device stores the spelling its engine
  validates (Hermes rejects `Asia/Kolkata`). Notifications, EventKit's
  floating zone and timed reminders stay on the device zone.
- **The device's own zone is an entry, not an id** (2026-10-10, #174) — the
  stored list names this device's zone by the word `device`, resolved
  against the OS on every read: the grid follows a flight even once a
  second zone was added (before, adding one froze the list to ids and
  nothing followed the device again), and an exported file reads right
  on another device. Always present and never removed, first by
  construction, primary or not; the cap of three includes it; a fixed
  zone the device is in right now draws once. Rejected: a removable entry
  with a pinned picker row (one more state for the one user who wants no
  device line); a label alone (the gap was the model, not the row).
- **The time zone picker lists every zone** (2026-10-10, #177) — it opens
  on the whole catalog, which scrolls, and typing narrows it, so a zone
  can be found by browsing as well as by name; "Add time zone…" is a
  button. Rejected: keeping the 50-result cap (the list looked like the
  catalog and was not); an "Add device time zone" button (the device
  zone cannot be removed since #174, re-landed here after it merged into
  the dead #173 branch). Left open: the list is in catalog order, grouped
  by region, not sorted by city.
- **Zone labels stack under their cities** (2026-10-11, #181) — with a
  second zone the gutter said what time it was, not where: each zone now
  has its own line under the hour, the header over the gutter names the
  cities in that order, and a shade per place (primary in ink, then two
  greys) matches line to city; the inspector, detail sheet and editor
  stack the same way, a tall block keeps one joined line. The third grey
  is a new token at 3:1, the non-text bar: three steps that all clear
  4.5:1 at 9 px read the same. Rejected: the `·`-joined line (it needed
  the order memorized). Left open: a long city name truncates.
- **Design tokens and dark mode** (2026-10-07, #135) — the brand kit is
  the one palette (a brighter purple and Serenity's indigo were tried and
  rejected); generated, never edited; the desktop maps tokens into
  Tailwind and follows the OS over `prefers-color-scheme`, iOS reads the
  typed tokens; calendar colors are tinted per theme, not mapped. Rode
  along: notes as an editor field, undated task creation, quick-add
  understanding to-dos, `lastView` / `sidebarCollapsed` as device taste
  (never exported), an agenda view kind.
- **Desktop redesign** (2026-10-07, #136) — one toolbar, one side panel
  that is the Today rail, search, a read-first inspector or the inline
  editor; the ⌘K command bar and the centered editor dialog are gone.
  Click = inspector, Edit = editor; the panel never joins the dialog
  stack, so a real dialog over it keeps Escape. Tasks drag from the panel
  too. Settings became a sidebar window with search.
- **iOS redesign** (2026-10-08, #137) — expo-router owns the screens
  (native tabs Calendar · Tasks · Search, Settings as a modal route, never
  a tab); one editor host owns every sheet so both tabs open the same
  ones; sheets stay React Native page sheets (`@expo/ui`'s BottomSheet
  would put the forms behind `RNHostView` and out of Maestro's tree);
  `@expo/ui` where it is a drop-in. The view is a menu and device taste.
- **iOS Settings pages** (2026-10-08, #148) — one native stack in the
  modal, a page per Mac pane minus Agents. Rows are React Native drawn on
  the tokens, not `@expo/ui` SwiftUI (Nik's pick); the switches _are_
  `@expo/ui`'s, because React Native's `Switch` lays out at the pre-iOS 26
  size and drew off-centre; no header background (it hid the large
  title). Done sits on the root only. The mirror page is a summary with
  the unchanged editor sheet behind it (Nik's pick).
- **Settings File, not Advanced** (2026-10-10, #171) — the Mac's
  Advanced pane held only Export & import and the watched file, so it is
  now Settings File; iOS gets a page of that name and keeps Advanced for
  Diagnostics and PR Preview. One pane, not two: each half is too small
  alone and they explain each other. Rejected names: Export & Import (the
  watched file is neither), Transfer (hides the file's scripting use),
  Backup (no calendar data in it). The pane id is `file`, since
  `settings:open` takes letters only; the desktop's watched-file card is
  now "Linked file" so it does not repeat the pane title.
- **No General pane** (2026-10-13, #192) — General held four unrelated
  cards, so each is now found by its own name: Time Zones, AI Model and
  Screen Sharing are panes on the Mac (iOS has only Time Zones of the
  three), and the location cache moved under Advanced on both, which the
  Mac regains for it. "Screen Sharing", not "Privacy" (the OS's own pane
  is Privacy & Security) or "Screen Privacy": the options read "Screen
  Sharing: Hidden", and it is where someone looks before a call. A
  single-card pane drops the card's heading rather than repeat the title;
  a window remembered on `general` falls back to Accounts.
- **No large title in iOS Settings** (2026-10-23, #240) — Back to a
  Settings root tall enough to scroll (two accounts do it) froze iOS 26
  once the mirror editor sheet had been up: UIKit flipped the root
  between its large and small title on every layout pass, and
  react-native-screens kept asking for another pass. The root takes the
  pages' small title. Rejected: patching react-native-screens (no native
  patches; it moves with the SDK), padding the root out of the bad
  heights. A signed-out second fixture account makes CI's root scroll.
  Search keeps its large title (nothing pops to it).
- **Search** (2026-10-09, #152) — one rpc over what the views can show:
  a two-year window either side of today, not the history (full-text
  recall is a backlog item); a matching series is walked outward from
  now, not expanded (an hourly series would pass the expander's cap);
  matching is TypeScript, not SQL (LIKE folds neither accents nor
  non-ASCII case); one hit per series at its next occurrence; iOS uses
  the native `Stack.SearchBar`, so nothing native changed. Deferred: an
  agent search tool, calendar names as search text, highlighting.
- **Search filters** (2026-10-12, #186) — search takes a `SearchQuery`
  (words and filters), shown as chips edited by hand, and a sentence the
  model reads edits the same struct as a turn with Undo — the create
  thread's shape over another state. Chip edits are not turns (the
  user's own); the model's answer is held to the words (dates the code
  reads win, a place, people or a calendar name must be in the words,
  kind and all-day are the code's); a filter only an event answers
  leaves tasks out. Enter is routed by code: plain words open the top
  result, a filter cue reads. Rejected: Enter always asking (a model
  round trip per Enter), only a button, FTS5 here. Open: term expansion,
  German prompt lines, an agent search tool, retrieval past the window.
- **iOS account button** (2026-10-09, #157) — Settings opens from an
  account avatar at the top right, as Apple's and Google's apps do; the
  unsynced pill became its badge. Rejected: a Settings tab (the bar is
  full and tabs are navigation), an item in the view menu, a "…" menu
  holding only Settings, the system Settings app.
- **Task checkboxes** (2026-10-09, #158) — drawn, not typed glyphs: one
  round box on both platforms (a circle because events are rounded
  rectangles), the Reminders list color as ring and fill, a done chip
  keeps its fill at full strength and only the title fades (the whole
  chip at 50 % hid the checked state). Designed on a canvas first.
- **Add flow** (2026-10-10, #167) — "+" opens the editor with the
  quick-add field on top and an Event | Task | Reminder control: the
  editor is the review step, so iOS's three surfaces for one intent and
  its direct-create path are gone, as is the desktop toolbar field (⌘K
  opens a new item). A phrase fills the form; Apply is not a required
  tap. **Reminder is a kind, not a list** — a list pick never changes the
  kind. Defaults follow the view (the Tasks tab's "+" opens an undated
  to-do in the filtered list, #164). The inline add fields went; the
  cost is one tap. The iOS control is drawn in RN so each segment can
  carry a test id.
- **Editor question footer** (2026-10-10) — the desktop editor's inline
  question (a lossy switch, move, conversion or delete) is a footer of
  the panel below the scrolling form, not the form's last row, so it is
  on screen whatever the scroll position; its text is capped at a few
  lines and scrolls on its own, so the answers stay in view at the
  smallest window. Not next to whatever asked (split between the panel
  and the forms, and still hidden when Save is), not a modal (the panel
  stays off the dialog stack). iOS needs nothing: its question is a
  native alert.
- **Experimental: mirrors and agents** (2026-10-09, #153) — a label in
  Settings, not a switch: both do nothing until set up, so a gate would
  guard nothing and switch off mirrors people run. Grouped under an
  "Experimental" heading, not badged; each pane says what that means.
- **Accessibility leftovers** (2026-10-09, #151) — notices stack in one
  column, failed write / discarded change / banner top to bottom (the
  banner holds the anchored edge because it stays until answered); the
  conflict banner is a labelled region, not an alertdialog and not a
  live region (its table would be re-read on every change), each parked
  change announced once; Dynamic Type is capped only where a box cannot
  grow (`BOX_FONT_SCALE`), everything else scales fully.

- **Mini month follows the view** (2026-10-10, #176)
  — the desktop mini month highlights the days on screen, not the focused
  day's Monday row (a rolled Wed–Tue week crosses two rows); a picked day
  leads the strip and is slid to, not jumped to its Monday week. Far picks
  slide the last two windows instead of every day between (a gapped strip
  would break the all-day spans and the range). Search results,
  notification taps and Today still jump; the month view highlights
  nothing. Codex review: a held press keeps the slide's columns, a second
  pick continues mid-slide. Open: the all-day lane can resize when a slide
  ends.
- **iOS event notes** (2026-10-13) — the iOS event form gets the Notes
  field the desktop editor has had since #135, last in the form after
  notifications as there. The shared model already loaded and saved
  `description`; only the field was missing. A read-only calendar shows
  its notes uneditable and offers no empty field. Open: notes are the
  stored text, so a description written as HTML in Google's web UI shows
  its markup on both apps.
- **iOS detail follows its event** (2026-10-14, #207) — as the desktop
  inspector since #156: it shows the record as it is now, Edit and
  Convert seed from it, a gone event closes it, a failed read keeps it up.
  With no grid range it reads `findCurrentEvent`'s lookup as an atom
  (`currentEvent`, re-read on every events change), not a window plus a
  lookup. No Maestro step: nothing on iOS can change an event under an
  open sheet. Review: a failed Apple read or lost access answered no
  events, read as "deleted"; the lookup now asks `strictApple`. Open: an
  Apple event moved over a day away closes it (no lookup by id).
- **Place candidates** (2026-10-18, #225) — a free-text lookup takes only
  a MapKit match that resembles the text, and asks for the top five so a
  choice can be offered (`placeCandidates`, uncached); a region hint from
  the user's own events, else the primary time zone's city. Probed first
  (Vienna names): the natural-language search recovers "Fickelmüller",
  the completer does not; neither recovers a dictated "Cafe Zentral",
  which a Kölner Phonetik key over past places will (phase 2); "Room 4"
  got a pin in Weidling, "the office" a bar. A model place must be in
  the phrase, and one that is title words too only after "at", "in",
  "bei", "im"…: "Dentist" and "Board review" were places. Rejected: a
  location permission (the geo seam never prompts); keeping a place that
  is the title's start ("New York trip" — the user adds it; "Dentist" was
  the common case). Open: chips for the candidates and past places.
- **Place choices** (2026-10-18, #226) — a phrase's place is looked up
  when a turn sets it: the user's own past places first (a year of
  occurrences, matched by the text they were written as, MapKit's name,
  or sound — the dictated "Cafe Zentral" case MapKit cannot recover),
  then MapKit asked two ways (the search reads a misspelling, the
  completer knows a place's branches), hits that do not resemble the
  text last. The best resembling one is taken at once — its text replaces
  what was said and its pin is vouched, so Save sends the coordinates —
  and every candidate stays as a chip under the quick-add field, the
  taken one pressed, with "As said" and ×: Nik wants the top match
  applied and the alternatives always in sight (2026-10-19; a first cut
  asked instead of taking when two ranked the same, and hid the row once
  one was taken). Rejected: an "assumed" tint on the field; asking the
  model. Open: the typeahead's empty state as recent places.
- **A save closes only its own panel** (2026-10-21, #230) — a desktop
  editor's close (Cancel, or Save and Delete once the write answers)
  applies only while the panel still holds that editor's opening; the
  inspector's Delete only while the panel shows an event it took (core
  `deleteTakes`: a series' scope takes siblings), an editor opened on it
  meanwhile included. A late reply used to close whatever was opened
  since (EventKit can take hundreds of ms). Rejected: ignoring grid
  clicks while a write runs; dropping the close inside the shared editor
  models on unmount. Open: a reminder reopened during its own Delete
  stays up. iOS followed in #232.
- **iOS sheets close only their own** (2026-10-21, #232) — the iOS
  editor route closes on its write's reply only while the host's sheet
  still holds that opening (`closeEditor`), and the detail's Delete only
  a sheet showing an event it took (`closeDeleted` over `deleteTakes`,
  an editor Edit or Convert opened meanwhile included), as the desktop
  since #230. A half-height editor takes taps behind it, so a detail or
  a slot's editor opened while the write ran closed with its reply.
  Rejected, as on the desktop: ignoring taps behind the sheet while a
  write runs; dropping the close when the editor unmounts. Open: an
  item reopened during its own editor's Delete stays up, as there.
- **A share's thread waits for what is open** (2026-10-22, #237) — an
  iOS capture runs under a banner that blocks nothing, so the user can
  open an editor, a detail or Settings meanwhile; its thread replaced the
  sheet, an editor's unsaved input included. It now opens only once
  nothing is up. The desktop's capture dialog is modal. Rejected: waiting
  for an editor only (a detail tapped behind it never showed, Settings
  got the thread on top); offering the result from the banner (a step
  more when nothing is open); dropping it. Open: nothing says it waits.
- **Weekend shading** (2026-10-24, #246) — the weekend's days sit on the
  `weekend` token in the time grids, the all-day lane and Month on both
  apps; Settings › Calendar turns it off and picks the days (Sat+Sun by
  default), and both travel in the settings document. The days are the
  user's, not the region's: iOS has no region API here (no
  expo-localization, Hermes lacks `Intl.Locale`) and the app ignores the
  region elsewhere. Rejected: region detection (Electron's `getWeekInfo`
  alone would split the platforms). Open: find-time's "Weekends" and
  quick-add's "weekends" still mean Sat+Sun; Desktop dark mode's shade
  reads lighter than the grid but darker than the lane and Month.
- **Today's backlog folds, a long lane scrolls** (2026-10-24, #247) —
  two or more overdue or undated tasks on today fold into one chip per
  group ("⚠ 12 overdue", "11 no date") opening their list (a desktop
  popover whose rows drag out, an iOS page sheet), which keeps a ticked
  row struck through; a lone task stays a chip. Expanded, the lane stops
  at a third of the view and scrolls inside itself, cut halfway into the
  next chip; "less" became a chevron. Rejected: always folding, one chip
  for both groups, dropping the collapsed mode (its "+N more" names the
  day), a draggable divider. Open: the month cell still lists the
  backlog; late completions still add struck chips on today.

## Invitees, contacts and birthdays

- **Attendees** — a replacement guest list on the draft; every write with
  guests sends `sendUpdates=all` — decided: always notify, never ask. The
  organizer chip is not removable.
- **Device contacts** — our own bridge over CNContactStore, not
  `node-mac-contacts` or `expo-contacts`; read-only, held in memory,
  never written to SQLite. The hardened runtime needs the Address Book
  entitlement on app and helper even without App Sandbox.
- **Google contacts** — cached, not live: saved contacts and "other
  contacts" with People sync tokens in a `contacts` table; existing
  accounts re-consent through "Add Google Account"; the People API, not
  the retired Contacts API.
- **Birthdays** (2026-09-12) — from People `birthdays` and
  `CNContactBirthdayKey`, merged per person by folded name + MM-DD, not
  from Google's Birthdays calendar (skipped: it would show everything
  twice and carries no year); their own table, since a person needs no
  email to have a birthday; a neutral chip with a fixed pink accent;
  Feb 29 renders on Feb 28; no cross-column spanning on the phone. Month
  views list events first (they carry the calendar's color), then
  birthdays, then tasks, as read-only summaries (2026-09-15).
- **Birthday reminders** (2026-09-12) — lead days + one delivery time in
  `device_settings`, the first preference that never syncs (SQLite via
  rpc, not a per-platform settings file: the consumer is a backend job in
  both hosts). Electron has no permission query, so the desktop asks by
  posting the banner — "show" means granted, "failed" denied, an
  unanswered prompt counts as granted.
- **Per-person overrides** (2026-10-04, #108) — a per-person list that
  inherits until touched (an empty list mutes; "Use defaults" removes the
  entry), keyed by name + month + day (`birthdayMergeKey`), not the merged
  record id, which changes when a source comes or goes and differs per
  device. Accepted: a rename drops the override. Travels in the settings
  document; an import joins by person and never removes one.
- **A time per reminder** (2026-10-24, #244) — each birthday reminder is a
  lead plus its own time, general and per person, one per lead; a lead
  added starts at the nearest one's time. Rejected: one default time plus
  per-lead exceptions (a hidden field once every lead has its own). Data
  and files in the old shape upgrade on read at the one time they had;
  the format kept version 1, so an older app reading a new file gets a
  schema error, not "update the app". iOS lists the reminders on the page
  itself (Add Reminder sheet, swipe to Delete): the pushed Remind Me page,
  opened from the Alerts lesson, landed in Settings' stack, whose separate
  editor never saw the change. `useSettingsEditor` yields once it lands.
- **Invitees from a phrase** (2026-10-17, #222) — only words that ask for
  an invitation invite; "with Sarah" never does, since an invite emails
  them. Who is a people-only second prompt, asked when code sees a cue:
  in a refinement Apple's model wrote the guest into the title and named
  no one. A name becomes a guest only when it means one contact, else the
  user picks or lets it go; the words' spelling wins ("Järg Möller" was
  returned for "Jörg Müller"). Rejected: a contacts tool for the model,
  taking the top-ranked contact. Open: pronouns ("invite her"), capture.

## Google Tasks and Apple Reminders

- **Google Tasks sync** — `updatedMin` watermark with tombstones plus a
  daily full pass; a separate `GoogleTasksClient`; the `tasks` scope is
  gated per account by `tasksEnabled` from the granted scopes, so
  calendar-only tokens keep syncing; `due` is date-only end to end.
  Creates live under a temp `local-` id the push swaps everywhere; an
  edit folds into a create only while it is undispatched, else queues
  behind it so the retry's adopt check still matches (2026-09-10); a
  later edit of another field merges field by field (#111).
- **Apple Reminders** (2026-09) — EventKit through the existing Swift
  helper on macOS and a local Expo module on iOS, one shared Swift source;
  `expo-calendar` rejected (no priority, no all-day/timed distinction). A
  synthetic `apple-reminders` account with provider-dispatched mutations
  and no pending-op queue (EventKit is local); per-provider forms. SQLite
  holds the complete snapshot (no date window) refreshed by an id-list +
  delta protocol; `EKEventStoreChanged` is latency, the 90 s pass is
  correctness. Writes are EventKit-first and EventKit is the truth: a
  mirror write failing after the commit is logged, not raised (a retry
  would duplicate); Save sends only dirty fields; read-only lists open as
  viewers and EventKit stays the enforcement. Timed reminders draw as
  compact move-only blocks on a fixed 24-hour wall-clock column and never
  go through a time zone.
- **By-day repeat rules** (2026-09-20, #81) — weekly weekday sets and one
  monthly ordinal for reminders and events, Nik's pick over weekly-only or
  reminders-only after his "Weekends" reminder opened as "cannot edit".
  One `ByDay` type shared by the structured rule, `TaskRecurrence` and
  the editors; the wire stays minimal — weekdays are sent only once
  explicit, so an untouched Save never rewrites a rule Reminders.app
  stored and moving a date never pins the weekday; a monthly rule on a
  plain weekday stays unsupported (Reminders.app cannot create one;
  rewriting it as weekly would be a silent change).
- **Move a task between lists and providers** (2026-09-21, #82) — one
  `moveTask` rpc mirroring `moveEvent`: Apple → Apple is EventKit's
  in-place list change, every other route creates in the target and then
  deletes the source (a failure leaves a duplicate, never a lost task);
  the rpc carries the editor's draft, so a task can gain a time on its way
  into Reminders; the loss preview is pure core, no preview rpc. Google →
  Google is not a server move (`parent`/`position` do not follow; since
  #201 it is, see below, with a preview rpc). The
  fake Google API became an app fixture for both e2e suites — no HTTP
  mock server; it sits behind effect's HttpClient with a memory
  TokenStore.
- **Task moves keep the hierarchy** (2026-10-13, #201) — inside one
  Google account a move is Google's `tasks.move` (id kept, subtasks along,
  a queued `moveTask` op like the event `move`) instead of
  copy-then-delete, which deleted a parent's subtasks with it on Google.
  Other routes copy the subtasks too, nested on Google, as reminders of
  their own in Reminders; `previewMoveTask` names a subtask leaving its
  parent and subtasks Reminders flattens. Rejected: refusing to move a
  task with subtasks, and flattening them on Google. Open (todo.md):
  drawing the hierarchy and reordering; a delete or conversion of a
  parent did not mention its subtasks (since #203 it does, see below).
- **A parent's delete names its subtasks** (2026-10-14, #203) — Google
  deletes a parent's subtasks with it, so a Google task delete takes them
  first, each a delete of its own (discarding one keeps the parent too);
  the question counts them (`previewDeleteTask`), as do the task → event
  preview (`previewTaskToEvent`, now the backend's) and an agent's
  `delete_task` summary. Rejected for a conversion: carrying them along —
  an event holds no subtasks, so "along" meant leaving them un-nested (a
  same-list `tasks.move`, unverified live, a new queue path) or folding
  them into the description, where they stop being tasks. Open: nothing
  un-nests a subtask in place (a move to another list does).
- **Subtasks drawn under their parent** (2026-10-14, #209) — core
  `nestSubtasks` nests each inbox section on both apps: a subtask under
  its parent when both are in the section, siblings in Google's
  `position` order, top-level rows in the section's own order. A subtask
  whose parent is in another section, completed or filtered out stays a
  row where its date puts it. Rejected: pulling it under the parent (a
  late subtask would hide under an undated one) and repeating the parent
  as a header. Display only: reordering and re-nesting through
  `tasks.move` need a new op, an optimistic position and drag UI on both
  apps — its own PR (todo.md).
- **Reorder and re-nest tasks** (2026-10-15, #210) — `reorderTask` queues
  a same-list `tasks.move` (`parent`/`previous`); the row shows a key
  between its new neighbours at once. Google renumbers siblings and bumps
  no `updated` (probed live), so the landed move reads the list's order
  back. Desktop: drag within the section (half an indent sideways nests
  or un-nests), ⌘]/⌘[; iOS: swipe right for Indent/Outdent, as Reminders.
  Top-level rows keep day/title order and no drop leaves its section (a
  date bucket of lists whose positions do not compare). Rejected: local
  renumbering, an iOS long-press drag (not drivable in Maestro). Open:
  top-level order by position, iOS subtask reorder, creates' renumbering
  (since #211 every renumbering, see below).
- **Order made elsewhere** (2026-10-15, #211) — a poll reads a list's
  order when the list's own `updated`, already fetched every pass, moved
  since the last read: probed live, every insert, delete, completion and
  move bumps it, a title or notes edit does not, and no task's `updated`
  moves. Nothing on an idle poll, one order-only listing otherwise; a full
  pass reuses its own. A landed create sorts first at once, as Google put
  it. Rejected: a read-back after each create (this device only), an order
  listing every poll or every Nth (a request per list per poll), a shorter
  full pass. Open: a move to another list made elsewhere (next entry).
- **Moves made elsewhere** (2026-10-15, #217) — another device's move to
  another list sends the source no tombstone, but bumps its `updated`: the
  order read then names every live task, so a synced row it no longer
  names goes, subtasks with it (probed live: their `updated` moves too, so
  the destination's pull brings them). Pending rows stay; the pass holds
  the drain. A paged listing is no snapshot, so rows go only while the
  list's `updated` reads as before the pass (one tasklists.list more).
  Rejected: a `tasks.get` per vanished row, a full pass of the list when
  one vanishes. Open: the full pass's `deleteStale` trusts its paging.
- **Convert events ↔ tasks** (2026-09-28, #93) — the same copy-then-delete
  through a shared `crossStore` ordering. The confirmation asks only when
  a set field has no home on the other side: the end time never counts, a
  link finds a home; only a chosen time counts (the editor's default hour
  is neither carried nor asked about); a recurring event converts as its
  whole series; a per-occurrence conversion is a follow-up.
- **Back to "No due date"** (2026-10-13, #198) — `updateTask` takes
  `dueDate: null` on both providers and the editor offers "No due date"
  on existing tasks. A Google op carries `taskDue: null` behind a
  `task_due_cleared` column (a `''` sentinel in `task_due` rejected).
  A repeating reminder's rule goes with its day and Repeat hides while
  undated, as in Reminders.app — rejected: a save error asking to set
  Repeat to Never first; a rule the form cannot show keeps its day.
  Relative alerts stay on an undated reminder; moving an undated task
  to another list still asks for a day (todo.md).
- **Access lag after Allow** (2026-10-22, #236) — iOS can report a just-
  granted Reminders or Calendar prompt as notDetermined for seconds, and
  the Swift bridges refuse every read and write on that status, so the
  pass Connect starts flagged the new account "Access off". A refusal
  citing notDetermined after this process's granted prompt is now one
  failed call (a request error), never lost access; `bridgeMessage` drops
  the throw site Expo appends, which hid every iOS refusal's status.
  Rejected: relaxing the bridge's check (a store without access answers
  with no calendars, and an empty snapshot wipes the mirror). Open: lists
  wait for the next pass if the lag outlasts the first one.

## Apple Calendar

- **Calendars mirrored, events read through** (2026-09-19, #78) — a third
  EventKit seam under one synthetic `apple-calendar` account. No local
  rows and no window: EventKit already is a local database and expands
  series itself — Nik wanted neither a rolling window nor drift from
  Calendar.app, and the backend rpc stays the one query surface for
  search and agents. Birthdays and sources named like a connected Google
  account are skipped. EventKit-first writes with scopes mapped to spans;
  guests and RSVP are Google-only, hidden in the editor and rejected by
  the mutation layer. Moves take the whole series: a server `events.move`
  inside one Google account, EventKit's own calendar change between Apple
  calendars, otherwise copy-then-delete that drops guests and modified
  occurrences after a confirmation (`previewMove`). Open: the two
  _(verify)_ items in `docs/google-sync-and-testing.md`.
- **Invitees on Apple events** (2026-10-13, #189, desktop) — the field stays in
  sight, disabled, with a note and "Open Calendar", instead of vanishing:
  a missing field read as a bug. Rejected: writing attendees through
  private EventKit API (fragile, no reliable invitation) and AppleScript
  (attendees are read-only there too). The button opens Calendar.app, not
  the event: no deep link is verified. Open: the same on iOS.

## AI

- **On-device models only** — no data leaves the device, no API keys, no
  per-request cost, works offline; this matches the app's posture. Apple's
  ~3B Foundation Models handle extraction and classification, not
  multi-step reasoning, so **the model parses intent, deterministic code
  does the work** — which keeps the valuable logic in `packages/*`,
  unit-testable with a fake provider. iOS through `@react-native-ai/apple`,
  desktop through a Swift helper over stdio (Foundation Models is
  Swift-only), weak-linked so the binary runs on any macOS and reports
  unavailable below 26; the renderer owns the microphone.
- **Quick add, find a time, dictation** — one shared parser and a
  prefilled-editor hand-off, never an auto-save; find-a-time parses only
  the constraint sentence and a pure solver does the rest, chronological
  ranking v1; dictation availability is decided by attempting `prepare()`
  (the readiness flag is false until assets exist) and the recording is
  deleted immediately. The simulator has no speech assets.
- **Find a time is the event form's tool** (2026-10-10) — not a mode of
  the quick-add field. The two modes shared a field and a title and
  nothing else: different prompts, a calendar read and a solver only on
  one side, and results of different shapes. "Find a time" sits beside
  the date and times (`FindTimeFields`, `useFindTimeModel`): presets
  over the pure solver (today / this week / next week / 2 weeks;
  daytime (08–20, the solver's default, named rather than called "any")
  / mornings / afternoons / evenings; any day / weekdays / weekends; a
  duration starting as the form's own), a Search, and the slots as
  buttons — a pick moves the event there (`applySlot`; an all-day series
  keeps its kind, so it has no finder). What the save will move or
  drop is not its own busy time (`rescheduledEventExclusion`, read off
  `updateRecurring`: the row for "This event"; every drawn occurrence
  for "All events", while a stored exception keeps its times and stays
  busy; everything from the split for "This and following", which is
  "All events" from the first occurrence; nothing of a series with
  fixed RDATE dates or a clock-pinning BYHOUR rule, since a drawn row
  does not say what placed it and those stay put through both edits,
  and nothing of a series
  whose master is not here — an Apple series never is, its rows being
  read through EventKit, so an Apple series edit searches around its
  own occurrences; too busy is the safe side). It works without Apple
  Intelligence; with it, a phrase fills
  the same presets (`parseFindTime`) — dates, hours or days outside
  them show as a note with nothing selected — and a title it names
  fills an empty title. An answer landing after a constraint changed or
  the finder closed is dropped.
  Not merged into the quick-add prompt: the on-device model is small
  and the two prompts are tuned apart. Timed reminders still do not
  count as busy, and guests' free/busy is not fetched — the finder is
  where both would go.
- **The phrase grounds the model's answer** (2026-10-11, #182) — probed
  on device, the ~3B model filled
  every optional field: 13:00 for "dinner", 00:00 with isAllDay false for
  a timeless phrase, "task" for a lunch, a Thursday for "next Friday", a
  Tuesday and 120 minutes in every finder answer. So `grounding.ts` reads
  the phrase itself and the normalizers keep a model value only where the
  phrase supports it: a start must be a stated clock time (corrected or
  filled when the model disagrees or omits it) or a named meal's or part
  of the day's default (one table, also the finder's bounds), else the
  event is all day; the end comes only from a stated range; a named
  weekday is where the date lands; a to-do needs a cue word, so `kind`
  left the schema; the finder's duration is the form's unless stated,
  its window the words' when named, its weekdays only when named.
  Rejected: a larger model (it would guess 19:00 instead of 13:00 — a
  better guess, still a guess), prompt-only fixes (the prompt already
  forbade inventing), asking the model where a value came from. Open:
  capture items (no phrase per item), German "morgen" (also "morning"),
  an "assumed" badge for the default times — with the draft thread.
- **The title holds only the phrase's words** (2026-10-24, #248) — "lunch with
  tom tomorrow" came back "Lunch with Sarah": the model copies a prompt's
  example title into any phrase of its shape. The prompt lost its examples;
  `groundTitle` keeps the model's title only when its words are the
  phrase's (plus ones naming no one: "with"), else the phrase stands in;
  `trimWhen` takes the when off the ends, never a span's, a name's or one
  it half-reads ("until Friday", "Black Friday"); a place a cue leads into
  leaves for its field, and a when or company is no place. Rejected: the
  example behind the check, a rule-only prompt, a code-only title. Open:
  mid-title when-words, "tomorrow lunch with tom" → "Lunch".
- **A served model beside Apple's** (2026-10-12, #184)
  — the desktop can answer `generateJson` from a model served over HTTP
  on this Mac: Ollama through its own API (the schema as `format`,
  grammar-constrained like the helper's guided generation; `num_ctx` per
  call since Ollama's default context is small; `keep_alive` so a
  thread's turns do not reload the model) or any OpenAI-compatible
  endpoint; picked in Settings › General, with a Test that lists the
  server's models. The choice, endpoint and model name are device-local
  (`userData/model-provider.json`, never the settings document); a key is
  safeStorage ciphertext only. Rejected: the provider in the renderer
  (the CSP and the window-level rule keep HTTP in main), Ollama-only (the
  OpenAI shape is free), an iOS endpoint over the LAN (another privacy
  posture; left out). The bench runs a phrase set through the models side
  by side — the evidence a Gemma download on iOS would need. Open: a
  per-model context from `/api/show`, image input for a served model,
  the `ModelInfo` capability record beyond the context.
- **The draft thread** (2026-10-12, #183) — a new item is
  a thread of drafts, not a one-shot prefill: the first phrase makes the
  draft(s), every later phrase in the same field changes them, Undo takes
  a turn back, and the grid draws every event draft hatched in its
  calendar's hue before anything is written; the form is the focused
  draft's view, "Add all" writes several; capture's events open as one
  such thread, its review list gone. A refinement is stateless — the
  draft as JSON plus the change, merged by the grounding rules with the
  draft as the anchor — not a `LanguageModelSession` transcript (4K
  context, session state across IPC, nothing the fixture could play).
  Rejected: letting the model resolve an open hour in a change (the
  draft's own start decides: a dinner "at 8" is 20:00), a `draft` tint
  variant (pattern over color — the hatch reads in both schemes).
  Desktop first; open: the iOS sheet (todo.md), drafts in the month
  view, a slot editor drawing its form as a draft, to-dos in "Add all".
- **The draft thread on iOS, in the sheet** (2026-10-12, #187) — the
  desktop panel's logic became `useThreadEditor`, which the iOS edit
  sheet runs too: the field takes changes, the turns with Undo, the
  free-slot chips, the pager and "Add all", the desktop's test ids; a
  share opens the editor as one thread of drafts and the capture review
  sheet is gone, as on the desktop. The editor and the calendar talk
  through kept-alive draft atoms (drafts to draw, a day to show, a click)
  instead of props, the desktop moved onto them. Rejected: a second
  iOS copy of the panel's effects (the quick-add field's two copies
  drifted once, which is why `useQuickAddModel` exists). Open: the
  drafts drawn behind a half-height sheet (todo.md).
- **Drafts on the iOS calendar** (2026-10-12, #188) — the editor became a
  form-sheet route (react-native-screens, half and full detents): a new
  item opens at half height over the live calendar, which draws the
  drafts dashed and tagged "Draft" (React Native has no repeating
  gradient for the desktop's hatch), the free slots dotted, a tap
  focusing or moving; the quick-add field leaves the focus alone so the
  keyboard does not raise the sheet. Rejected: `@expo/ui`'s BottomSheet
  (its SwiftUI host hides the form from Maestro, #137 — this sheet is a
  plain presented controller), a "show on calendar" toggle on the page
  sheet. Open: the desktop leftovers (todo.md), a detent set from code.
- **Mixed drafts, each in its own place** (2026-10-13, #199) — a draft
  keeps its kind and the calendar or list picked for it (with a
  reminder's own fields) in its extras; "Add all" writes events and
  to-dos alike, each where it was put, after Save's checks. A draft the
  form never held goes where the form points, so one pick still reaches
  every untouched draft; showing another draft is no kind switch (paging
  from a reminder to an event used to ask about its priority). Rejected:
  pinning every draft to the default calendar at creation (a pick on the
  first would stop reaching the rest — the common capture case), one
  calendar for the batch (what this replaced). Open: to-do drafts on the grid.
- **A changed field's tint holds, then fades** (2026-10-13) — #191's
  1.1 s fade was over before the eye reached the form: the tint now holds
  at full for 1 s and eases out over 1.5 s (`TURN_FLASH_HOLD_MS`,
  `TURN_FLASH_FADE_MS`), Settings' highlight on the row a link lands on.
  Rejected: just a longer fade (it spends its length half-faded and still
  reads as a blink), a tint that stays until the next edit (#191 turned
  down a lasting mark).
- **Thread turns newest first, two shown, changes flash** (2026-10-13, #191)
  — both threads, both apps: newest on top with Undo, wrapped, two then
  "+N earlier queries ⌄", hung under the field as one card with it.
  Nothing under the field moves: reading is a spinner in place, hints
  and failures are the field's placeholder (a click restores the words).
  Changed fields and chips tint and fade (1.1 s, kept under reduced
  motion). Reverses #190's one-line iOS row at Nik's call. Rejected: a
  lasting mark per field (the summary is the record), a status line
  under the field, layout transitions in the iOS sheet header. Open:
  long failures truncate in the field (tooltip/VoiceOver say all).
- **A tighter iOS editor header** (2026-10-13, #190) — the sheet's fixed
  header left the half-height form little room once a thread showed:
  the "Describe it" label went (the placeholder says it), the thread
  shows only its last turn, on one line with Undo (Undo takes back only
  that one; the desktop keeps the list), and the rows sit closer — the
  title field moved up about 100 pt. Rejected: starting at 60 % or 75 %
  height, which buys one or three form rows and costs the calendar the
  half sheet is for (on an iPhone 17 Pro about 3.5 or 1 hour of timeline
  stay in view instead of 5).
- **Editor forms as grouped cards, the header given room** (2026-10-17,
  #223) — #190's squeeze read as bad design once the half sheet was in
  hand. The iOS editor now draws its forms as iOS inset grouped cards on
  the Settings pages' rows (`GroupedList`, moved out of `settings/`), in
  Calendar's and Reminders' own order with the calendar card before the
  repeat card (picked far more often), a card's header uppercase
  ("CALENDAR", "REPEAT", "LIST"); the fixed header keeps the Cancel ·
  title · Save row and the quick-add field (a card on the ground, 17 pt)
  with its thread, and the kind control scrolls with the form. The
  desktop panel gets a header that stays (title, Close), captioned
  sections (When, Where, Repeat, …) and a footer that stays with Delete ·
  Cancel · Save. Rejected: a taller starting detent (#190's reasons
  hold), a pushed calendar picker (the inline rows stay the flows'
  targets and one tap), Repeat inside the dates card (its conditional
  rows made it long). Open: the chips at the accessibility text sizes.
- **A drag raises the half-height editor** (2026-10-26, #257) — the form
  scrolled on its own in the strip under the header. A drag up on the
  form or the turns now raises the sheet first, as in Maps; at half with
  the keyboard down the form sits at its top, the only place UIKit hands
  a drag to the sheet. The turns take a third of the sheet as it stands,
  not 30 % of the screen. Rejected: no scrolling at half (a dead gesture
  on a cut-off form), one scroll view for field, thread and form (the
  field would scroll away from its replies), a taller start (#190).
  Open: the chips, choices and pager under the turns are not capped.
- **Slot proposals in the create thread** (2026-10-12, #185) — a phrase
  that asks for free time is routed by code (`isFinderPhrase`: English
  and German cues, a search verb or question beside a time word) to the
  finder prompt, never by the model, so the two prompts stay tuned apart;
  the solver places each gap's slot at the named part of the day
  (`preferredTime`, the middle of the bounds the finder settled on) and
  `rankSlotsAround` orders the slots around it, half an hour counting the
  same, soonest first among equals; the thread takes the best as the
  draft and keeps the rest on it — a "Free slots" chip row and fainter
  dotted "Option" blocks, either moving the draft; the next turn drops
  them, Undo restores them. Rejected: a slider over the slots, asking the
  model whether a phrase is a search, a centre without a named period
  (chronological stays, as in the form's finder), turning a to-do into an
  event on a finder turn (it moves to the slot's start, no row). Open:
  the iOS thread's chips and candidates, a centre for the form finder's
  own presets, proposals for several drafts at once.
- **Hands-free dictation** (2026-10-15, #214) — one press of the microphone
  listens until the user takes over: a pause sends the phrase and it
  listens again, the form edited by hand, the field typed into, the
  microphone or 30 s of silence ends it. The pause is heard from the
  level alone against the room's floor (`createEndpointer`), so neither
  adapter needed native work. Rejected: streaming SpeechAnalyzer with live
  partial words (a new iOS module and a helper push channel), recording
  while a phrase is read (words said then would queue against a form
  still changing). Open: the pause length and margins by ear on real
  rooms, a live transcript, saying "undo". Fixed (2026-10-18, #224): on an
  iPhone no recording had ever started or been transcribed — expo-audio's
  `record()` starts nothing on an unprepared recorder, and its file is the
  `uri` property, not a `getURI()`; the adapter now prepares first, reads
  `uri`, and refuses to pass a recorder that did not start off as listening.
- **The model says why it is unavailable** (2026-10-10, #168) —
  `ModelStatus` carries disabled / not-ready / unsupported (Apple
  Intelligence switches itself off on a Siri-vs-Mac language mismatch); a
  not-ready model is re-polled; no "Open System Settings" button, the
  tooltip names the pane.
- **iOS quick add says why the model is unavailable** (2026-10-16) — a
  local Expo module reads Foundation Models' reason, since the package
  answers only yes/no and patching it was declined (#31); generation stays
  in the package. A failed or timed-out check is worded as a check that
  failed, never as a model state; Check Again reports every answer (time
  stamped, announced) and the technical details are collapsed text to
  copy. The notice now shows for every status, a missing module and an old
  iOS included. Open: the answers on a physical iPhone in each state,
  checked only on the simulator.
- **Capture from text or photo** (2026-10-04, #107) — OCR first, not
  image input: Vision reads the image on-device and the text goes through
  the existing `generateJson`; native image input exists only on OS 27 and
  `@react-native-ai/apple` is text-only, so `TextRecognizer` is its own
  seam (the permanent OS 26 path) rather than an image field on
  `LanguageModel`. An undated item is dropped, never placed on today; a
  past date without a stated year rolls forward. Review is a list whose
  rows open the existing editor, so "never an auto-save" holds. Desktop
  entry is ⌘V (a menu item and a main-process clipboard read were not
  worth it); iOS uses `expo-sharing`'s receive support with a wrapped
  plugin. Open: the real share sheet on a device (both variants), HEIC
  from Photos, whether 6000 chars / 8 events fit the context.

- **The model bench** (2026-10-25, #254) — `apps/desktop/e2e/bench/`
  grows the #184 phrase table into cases with turns (a phrase, then the
  changes a thread would make) through `parseQuickAdd` and `parseRefine`
  on Apple's model and any served one; a turn is text or a recording
  with its transcript; expectations per field, by where a person would
  put the event, a later turn held to leave what it was not about; a
  JSON report to diff two commits by. Measured, never gated. Rejected:
  exact-JSON snapshots (wording and dates drift), prompt variants as a
  parameter (two runs on two commits do), a CI gate (no model there).
  Open: the gaps the baseline shows, listed in todo.md (Tier 3).
- **Quick-add repeats are the phrase's** (2026-10-26, `todo/quick-add-repeat`)
  — `statedRepeat` (`grounding.ts`) reads kind, gap, days, ordinal
  weekday, count and span from the words; `recurrenceFromParse` builds
  the rule from that, in quick add and over a draft's rule in a
  refinement. No repeat word, no rule; the model's kind only behind a
  repeat word the code does not read, its count and gap never, its end
  only behind an until word naming a day. A rule with chosen days starts
  on the first of them. Rejected: sparing only the `count: 1` rule (the
  invented end a week on would have stayed). Open: negations, "twice a
  week", "2nd and 4th Tuesday", the title's trim of the new repeat forms.

## Notifications

- **Event reminders** (2026-09-22, #84) — reminders are data on the
  record in Google's `useDefault`/`overrides` shape (also what EventKit
  alarms map onto), edited in both editors and delivered by
  `LocalNotifications`, two producers merged into one OS schedule; a
  producer whose setting is off returns nothing, so disabling one no
  longer wipes the other's schedule. `remindersChanged` on the op because
  Google's PATCH replaces the object; `useDefault:false, overrides:[]` is
  "none", distinct from the field being absent. Apple Calendar events
  notify only when switched on (Calendar.app already fires those). The
  desktop permission banner is posted once on first start.
- **iOS background refresh** (2026-09-27, #92) — a `BGProcessingTask`
  (not the `BGAppRefreshTask` the backlog named) runs a bounded pull then
  a notification pass, in `packages/sync` so the ordering is unit-tested;
  defined before the root component registers. Google tokens moved to
  `AFTER_FIRST_UNLOCK` (chosen by Nik) so a pull can run while locked.
- **Notification taps and zones** (#119, #142) — the text is in the
  device's zone, an all-day reminder counts from midnight in the
  calendar's; a planned notification carries a target the tap resolves
  through the range query and then by stored id. iOS reads the permission
  without asking; Electron has no query.
- **The primary zone's time in brackets** (2026-10-15, #212) — a timed
  event reminder keeps the device's clock and, when the primary zone
  reads another one at the start, adds it: "9:00 AM (3:00 PM Vienna)",
  with the weekday once the date differs. Compared by offset, so a
  primary that is the device's clock under another name adds nothing;
  a time zone save re-plans. Rejected: the text in the primary zone
  alone (it would contradict the lock-screen clock beside it). All-day
  and birthday text has no clock and stays as it was.

## Calendar mirrors

- **Calendar mirrors** (2026-10-02, #103) — a mirror, not a workflow: one
  way, the app owns the copies, three presets and an Advanced
  disclosure, no rule engine (a Zapier-style workflow rejected). A
  reconcile with no mapping table: the destination is the state, any
  device can run it, a cut-off run runs again; the price is that every
  input must be device-independent (own queries past local visibility,
  the mirror's own zone, portable keys — EventKit's external identifier).
  Google writes bypass the pending-op queue (copies are derived) and use
  PUT (a switched-off field must leave the copy); a derived id makes a
  second device's insert a 409. Markers are opaque: the destination is
  shared with people who can read both carriers. Two devices set up by
  hand do not cooperate — the settings file is the only way across, an
  imported mirror arrives switched off. Two backstops for what EventKit
  cannot confirm: a large removal waits ten minutes, a third identical
  write within a day pauses the mirror. Apple destinations are iCloud,
  CalDAV or local (Exchange drops the URL). The editor can create the
  destination under `calendar.app.created`. Rejected: iCloud key-value
  sync of definitions (a new entitlement in every build). Open: a
  narrow-scope sign-in creating a calendar, a real two-device run, the
  new Swift paths against real EventKit.

## Agent gateway

- **MCP and CLI access for other agents** (2026-10-01, #99) — one gateway,
  two front ends over the same `callTool`, a curated tool set (no
  accounts, settings, conflicts, queue, moves or conversions). MCP is
  served in Electron main and the relay only pipes, running under the
  app's own binary (`ELECTRON_RUN_AS_NODE`) so agents need no Node — at
  the price of keeping the RunAsNode fuse enabled until a Swift relay
  exists. Levels per calendar and list (none < free/busy < read < ask <
  write), guests and contacts as separate switches; `none` answers
  NotFound so a denial never confirms a hidden calendar; hidden in the
  app = `none`. The gateway resolves a write's real container first:
  EventKit and Reminders address items by id alone. Ask-first stores a
  summary the app wrote, re-plans from the stored input on approval and
  runs only a plan whose summary equals the approved one; never through
  MCP elicitation, which the agent's own client could answer; summaries
  are never shortened, inputs are capped. A separate `agents.db`: the
  phone never has agents, and grants must not ride along with anything
  that syncs or exports. Token stored as SHA-256 only; a guardrail for
  agents that connect through it, not a sandbox. The app took a
  single-instance lock and a `--background` start so the relay can launch
  it. Hidden text is refused, not stripped (#114). Open: a real
  Hermes/OpenClaw session, the relay under the notarized build, a real
  guest invitation at "ask".
- **Settings window** (2026-10-02, #102) — Settings left the main window
  for a window of its own opened from the application menu (⌘,), as the
  HIG asks; panes, not a System Settings sidebar at first (five panes),
  later a sidebar with search (#136). One bundle and a hash route
  (`#settings/<pane>`) rather than a second vite entry; the pane lives in
  the URL hash and the page never writes its own state over it (review
  found the two ways a request made while the window opened was lost).
  No gear in the main toolbar — the menu is the way in.

## Review fixes (2026-10-04 … 2026-10-08, #110–#142)

Tier 0 of the 2026-10-02 read-only review, one PR each, a failing test
first. The decisions, one line each:

- The all-day switch on an existing series is refused, not supported —
  Google keys occurrences by date or date-time, so a real switch is a new
  series and needs a live-verified design; an all-day series moves one
  occurrence at a time (#110).
- A newer task edit of another field keeps the queued one's: latest wins
  field by field (#111).
- Read-only calendars: the mutation layer refuses writes, not just the
  UI; both apps stop the drag before it starts (#112).
- Only a Google account asks before removal, naming its unsynced changes;
  an Apple account only disconnects (#113).
- Agent text that would draw as nothing is refused, not stripped; a
  joiner or variation selector only inside a complete emoji (#114).
- Repeat-until ends in the series' own zone (#115).
- Notification text in the device's zone; an unloadable zone is read
  under its other spelling, else the device's (#119).
- The untitled placeholder stays in the record and is never written to
  Google (#120).
- Every editor write runs through one slot; `busy` only dims buttons
  (disabled swallowed the next click) (#124).
- A pulled event without a zone takes its calendar's, not UTC; a repeat
  end before the first day is refused by the editors (#126).
- Deletes confirm rather than undo — an undo would hold back the Google
  op and fake the row's absence, and an Apple delete is immediate (#129).
- One stack of dialogs; only the topmost answers Escape and traps Tab
  (#130).
- A calendar-list 410's full relist purges; an unreached request gets
  one retry, not five (#131).
- A sign-in can be cancelled, a cancellation is no error, and a reconnect
  sends `login_hint` (#132).
- The device zone is an atom read once a minute; Foundation's cached zone
  is reset per foreground/request (#139).
- A swipe that starts inside the previous commit animation takes that
  page at once; resizing needs the same hold as moving (#140).
- "New token" and "Remove" ask inline in the Agents pane (#141).
- Unsynced changes show why the last attempt failed and name their task
  (2026-10-10, #162).
- A key or a lost pointer capture mid-drag ends the drag instead of
  moving the drop; the e2e windows take CDP input only (Nik asked for the
  background over the top) (#166, #169).
- One availability rule, `blocksTime`: find-a-time, the agent's
  free/busy and slots skip events marked free and declined invitations;
  mirrors flag items with the same predicates and keep their own
  copy/skip filters. The finder reads account emails for the declined
  check, like the agent (2026-10-13, #197).

## Brand

- **App icons and brand kit** (2026-09-16, #67) — the "24" identity in
  soft ivory (lightened toward white, mint fold, blush backing); SVG
  masters are the source and every raster is generated by
  `pnpm brand:build`; the dark icon is the iOS dev variant's. An icon
  change alters the native fingerprint, so it reaches testers only
  through a TestFlight build.
- **Ink primary** (2026-10-18, #227) — the filled action, the today marker,
  the now-line, done checks and active chips take the text's warm charcoal
  (`primary` #2B2630 light / #ECE6EE dark); the focus ring is a grey-plum,
  selection and the changed-field flash are steps of each scheme's own grey. Replaces the
  darkened brand plum #584360 and the lilac tints, which weighed on the
  editor and colored its fields after a quick-add turn. Rejected: the brand
  plum as-is, mauve, green / blue / warm accents, and a charcoal button with
  plum or slate signals (needs an `accent` token the apps would have to
  split from `primary`). The plum stays in the identity only.
- **Text actions** (2026-10-19, #228) — with `primary` at the text's
  charcoal, text that acts gets a second cue: a link inside a sentence is
  underlined in the control-boundary grey, a standalone one (Make
  primary, Open in Maps, Add due date) takes the Button's medium weight
  (semibold on iOS, plus a hover underline on the desktop, where a red
  Remove beside it matches), and iOS Cancel / Close go secondary; iOS red
  rows keep the system's regular weight. Rejected: an underline on every
  text action (busy in rows of two or three) and `text-secondary` for all
  (reads as a caption). Fills, today markers, icons and checks keep plain
  `primary`. Open: iOS has no link inside a sentence yet.
