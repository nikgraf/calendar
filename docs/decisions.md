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
- **Versions** (2026-09-11) — the apps are `0.1.0` with a CHANGELOG;
  bump together when a release is worth a number.
- **Schema baseline** (2026-09-15) — the twelve pre-release migrations
  were collapsed into one, since nothing had shipped. The runner keeps
  its "ahead of this build" guard rather than a self-wipe (a pre-baseline
  database refuses to open and names `pnpm reset:local`). A one-time
  cleanup, not a policy: schema changes are appended migrations again.

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
- **Test pruning** (2026-10-09, `todo/prune-tests`) — a test goes only
  if a surviving test asserts everything it did; iOS flows are merged per
  area, not dropped, because a launch or a Reminders connect repeated
  across flows is the cost worth cutting (CI shards spend ~16 minutes on
  setup and are billed macOS minutes). Not done: table-driven merges of
  near-identical unit tests, shared test helpers.
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
  row, duplicate-id and downgrade guards that die loudly.
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
  delete's, a superseded op refused in flight puts nothing back. Open: an
  op queued before the snapshot can only mark its row synced; a deletion
  a full re-list confirms only by absence clears no snapshot; a per-item
  acknowledged copy would replace the per-op snapshots if more
  interleavings turn up.

## Calendar: editing, gestures, views

- **Drag to move and resize** — pointer drag on desktop, long-press pan
  plus a resize handle on iOS, shared snap math in core; gestures track
  input 1:1 and snap on release — Nik rejected discrete-step snapping
  everywhere (the trackpad pan eases to the nearest day only when the
  wheel goes quiet). All-day chips and the month view do not drag.
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
  its completion day (2026-10-02). No auto-scroll at the grid edge.
- **Screen-sharing privacy** — the desktop window is excluded from
  captures by default; "Visible for 10 min" is runtime-only and fails
  closed on restart; "Always visible" persists.
- **Per-calendar colors** — optimistic local update, write-back through
  `calendarList.patch?colorRgbFormat=true` as a `calendarColor` op kind
  coalescing per account; invalid hex rejected, 4xx dropped.
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
- **Search** (2026-10-09, #152) — one rpc over what the views can show:
  a two-year window either side of today, not the history (full-text
  recall is a backlog item); a matching series is walked outward from
  now, not expanded (an hourly series would pass the expander's cap);
  matching is TypeScript, not SQL (LIKE folds neither accents nor
  non-ASCII case); one hit per series at its next occurrence; iOS uses
  the native `Stack.SearchBar`, so nothing native changed. Deferred: an
  agent search tool, calendar names as search text, highlighting.
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
  Google is not a server move (`parent`/`position` do not follow). The
  fake Google API became an app fixture for both e2e suites — no HTTP
  mock server; it sits behind effect's HttpClient with a memory
  TokenStore.
- **Convert events ↔ tasks** (2026-09-28, #93) — the same copy-then-delete
  through a shared `crossStore` ordering. The confirmation asks only when
  a set field has no home on the other side: the end time never counts, a
  link finds a home; only a chosen time counts (the editor's default hour
  is neither carried nor asked about); a recurring event converts as its
  whole series; a per-occurrence conversion is a follow-up.

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
- **The model says why it is unavailable** (2026-10-10, #168) —
  `ModelStatus` carries disabled / not-ready / unsupported (Apple
  Intelligence switches itself off on a Siri-vs-Mac language mismatch); a
  not-ready model is re-polled; no "Open System Settings" button, the
  tooltip names the pane.
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

## Brand

- **App icons and brand kit** (2026-09-16, #67) — the "24" identity in
  soft ivory (lightened toward white, mint fold, blush backing); SVG
  masters are the source and every raster is generated by
  `pnpm brand:build`; the dark icon is the iOS dev variant's. An icon
  change alters the native fingerprint, so it reaches testers only
  through a TestFlight build.
