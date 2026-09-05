# Google API semantics & testing notes

## Verified Google Calendar API semantics

Everything below is either verified against the reference docs or proven by
the implementation + tests. When touching sync code, treat these as
invariants.

### Events & recurrence

- **Instance / exception ids**: an occurrence of a recurring event has id
  `<masterId>_<YYYYMMDDTHHMMSSZ>` (basetime = original start in UTC,
  compact); all-day: `<masterId>_<YYYYMMDD>`. Exception events created by
  modifying an occurrence keep that id — which is why our local override
  rows use it (`googleInstanceId` in `packages/core/src/recurrence/editing.ts`):
  the later sync pull upserts over them idempotently.
- Patching an instance id creates/updates the exception server-side;
  deleting an instance id cancels that occurrence (even if no exception
  row exists yet).
- **RRULE editing**: `UNTIL` must be UTC-basic format
  (`YYYYMMDDTHHMMSSZ`) for timed events, `YYYYMMDD` for all-day; `COUNT`
  and `UNTIL` are mutually exclusive (RFC 5545) — truncation drops COUNT.
  Recurrence lines never include DTSTART; it derives from the event start.
- **Client-generated event ids** (base32hex) make creates idempotent: a
  409 on insert means the create already landed — treat as success.
- **PATCH semantics**: omitted fields stay unchanged. Attendee arrays
  merge by email for non-organizer callers, and `responseStatus` changes
  for entries other than your own are ignored — RSVP therefore sends an
  attendees-only body and deliberately omits If-Match (a response should
  not lose to unrelated content edits).
- **412 (etag mismatch)**: we use If-Match on content updates/deletes when
  an etag is known; on 412 the server wins (drop op, toast, next pull
  replaces local).

### calendarList

- `calendarList.patch?colorRgbFormat=true` accepts arbitrary
  `backgroundColor`/`foregroundColor` hex; send **both** (foreground is
  not documented optional; omitting it has 400 reports). Google sets the
  nearest palette `colorId` automatically and subsequent lists return the
  custom `backgroundColor` — and `mapGcalCalendar` prefers
  `backgroundColor` over `colorId`, so custom colors round-trip with no
  mapper changes.
- **URL-encode calendar ids** in paths: birthday/holiday calendars contain
  `#` (`addressbook#contacts@group.v.calendar.google.com`) — unencoded,
  the id is truncated as a URL fragment.
- Colors must be full 6-digit hex; Google normalizes casing — we store
  lowercase (`normalizeHexColor`) so pull-after-push is byte-identical.
- The calendarList entry is per-user metadata: color patches work for any
  accessRole, including read-only calendars.

### Misc

- Meeting links: `hangoutLink`, else `conferenceData.entryPoints[]` with
  `entryPointType === 'video'`; `meetingUrl()` in core also scans
  location/description for Meet/Zoom/Teams/Webex/Whereby URLs.
- Sync: incremental via syncTokens; 410 → drop token, full resync,
  `deleteStale`. The special birthday/holiday calendars flow through the
  normal calendarList.

### Google Tasks (shipped)

- Separate API with no syncTokens: we poll with an `updatedMin` watermark
  (stored per account in `sync_state`, advanced to now−60s for clock
  skew) + `showCompleted/showHidden/showDeleted` so completions and
  deletions arrive as tombstones; a daily full pass catches anything a
  watermark can miss, then `deleteStale` (only `sync_status='synced'`
  rows).
- `due` is **date-only** (RFC 3339 with a meaningless time part) and
  there is **no recurrence exposure** — Google materializes the next
  occurrence of a repeating task when the current one completes.
- **Task ids are server-assigned** — creates are NOT idempotent (no
  client-id trick like events). See architecture.md for the temp-id +
  adopt-before-retry protocol.
- Completing sets `status: 'completed'` (Google also sets `hidden`);
  un-completing must clear `completed` via `status: 'needsAction'`.
- A 403 insufficient-scope (grants that predate the tasks scope) disables
  tasks for the account instead of retrying.

## Verified Apple Reminders (EventKit) semantics

- **Access**: `requestFullAccessToReminders` (macOS 14 / iOS 17+);
  `authorizationStatus(for: .reminder)` distinguishes fullAccess /
  writeOnly / denied / restricted / notDetermined. Access can be revoked
  in System Settings at any time — treat every pass's status check as the
  account's health, not the initial grant.
- **The helper is a bare executable**, so its usage strings ride in an
  embedded `__TEXT,__info_plist` (Package.swift `-sectcreate`); the app's
  Info.plist carries them too (forge `extendInfo`). Verified: both the
  dev Electron binary and the packaged .app obtain full access through
  the helper child and read the user's lists.
- **Ids**: `calendarItemIdentifier` is stable enough for a mirror but can
  change after an iCloud sync — the snapshot reconciliation makes that a
  delete + reinsert, never a stale row. Ids are server-assigned: no
  client-side idempotency trick, hence no queue. Deleting something
  Reminders.app already deleted answers notFound — treated as done.
- **Errors cross Expo as an envelope**: expo-modules-core rethrows a Swift
  throw as `FunctionCallException … → Caused by: RemindersBridgeError:
<message>`; the client unwraps the last `Caused by:` segment before
  matching the `accessDenied:` / `notFound:` prefixes (the helper sends
  the message verbatim).
- **Store lifetime**: the `EKEventStore` is created by the pre-prompt
  status call and `reset()` after a successful grant — a store created
  without access can keep answering with no calendars.
- **Due**: `dueDateComponents` with no hour ⇒ all-day (`dueDate` only);
  with hour/minute ⇒ timed (`dueTime` 'HH:MM' in the device zone). The
  bridge keeps `startDateComponents == dueDateComponents`, as the
  Reminders app does.
- **Priority**: EventKit 0…9; the Reminders app shows 1–4 high, 5 medium,
  6–9 low. We keep the buckets and write back 1/5/9/0.
- **Alarms**: only relative-offset alarms are surfaced (minutes, ≤ 0 =
  before/at); absolute-date alarms are preserved untouched by writes.
- **Recurrence**: freq/interval/count|until round-trip through
  `TaskRecurrence`; by-day / positional / multiple rules come back as
  `{ unsupported: true }`, the form shows them read-only, and writes
  never overwrite them.
- **Fetch**: one `predicateForReminders(in: nil)` — every reminder, open
  and completed, dated and undated. EventKit is local, so the fetch is
  cheap; the cost is the bridge payload on desktop, so `reminders.snapshot`
  returns all (listId, id) pairs plus full rows only for reminders whose
  `lastModifiedDate` ≥ `changedSince − 60 s` (the Google watermark's skew
  lag; re-reading the overlap is harmless — upserts apply only when
  strictly newer). Measured on a 9-reminder database: full 3.2 KB, idle
  delta 0.9 KB. The engine logs `reminders snapshot` at debug level with
  ids/changed/lists counts and fetch/apply ms; if a large completed
  archive ever makes a pass measurably expensive, the fallback is hybrid
  retention (all open, recent completed) — not built.
- **Change push**: `EKEventStoreChanged` fires for any EventKit change,
  including our own write-throughs and iCloud bursts; the engine
  debounces it (1 s) and runs a reminders-only delta pass under the sync
  gate, so bursts coalesce into one pass. It only reaches a live observer
  (the helper child can be respawned; iOS is suspended in the
  background), which is why the 90 s pass stays.

## Testing conventions

### Unit tests (`vp test`, @effect/vitest)

- Layer recipe: `EventMutations.layer` + `reposLayer` +
  `Layer.effectDiscard(runMigrations)` +
  `SqliteClient.layer({ filename: ':memory:' })` + reactivity layer +
  `Layer.succeed(GoogleCalendarClient, stub)` (+
  `Layer.succeed(GoogleTasksClient, tasksStub)` where tasks are
  exercised).
- The stubbed `GoogleCalendarClientShape` / `GoogleTasksClientShape` are
  **complete records** — every new client method must be added to every
  stub (typecheck enumerates them).
- AI pipelines never hit a real model in tests: the provider seams take a
  fake `ModelProvider`/`SpeechProvider` returning canned JSON, so
  prompt-building, normalization, and error paths are fully unit-tested
  (see `packages/ai/*.test.ts` and `findTimePipeline.test.ts`).
- Reminders never hit EventKit in tests: `makeFakeRemindersClient`
  (`packages/reminders/src/fake.ts`) is an in-memory store with the
  bridge's semantics (server-assigned ids, null clears, list moves,
  windowed listing, switchable authorization); sync/mutation tests read
  `fake.state` to assert what EventKit "saw". Every other layer recipe
  provides `unavailableRemindersClient('test')`.
- **Date-independence is a hard rule for every test involving "now"**:
  inject the clock (`nowUtc` parameter) or build dates relative to today
  with wall-clock times via Temporal in an explicit zone — never pinned
  dates or UTC-offset literals. Three CI breakages came from tests that
  passed on the day they were written and decayed.
- `getWindow` joins visible calendars: tests asserting through it must
  seed a calendar row, not just events.
- The SQLite driver is Node's built-in `node:sqlite` (same in tests,
  Electron, and CI) — no ABI split, no alias twin.

### Desktop e2e (`pnpm test:e2e`, apps/desktop/e2e/)

Raw CDP over Node's native WebSocket (no Playwright): the harness launches
the built Electron app with `--remote-debugging-port` and an isolated
`CALENDAR_USERDATA` profile, seeds SQLite through the app's own
migrations/repos, drives real input events, and asserts against both the
DOM and the database.

Flakiness lessons (each caused a real CI failure — keep them enforced):

- **Integer coordinates only** for `Input.dispatchMouseEvent` — fractional
  coords mis-fire.
- **`scrollIntoView` before measuring** (harness `locate`): CI runners
  land the week grid at different scroll offsets, leaving early-morning
  blocks under the sticky header where clicks hit the header.
- **Weekday-agnostic seeding**: recurring seeds start `today − 3 days` and
  expectations derive from the first _visible_ instance — absolute
  "today"-based expectations broke every Sunday.
- **Teardown**: await the Electron process `exit` (with timeout) before
  deleting the temp profile, and `rmSync` with retries — otherwise
  ENOTEMPTY races on slower runners.
- **Fire-and-forget UI mutations can silently drop**: poll for the effect
  and re-click after ~3s of no movement; assert relative change
  (`< before`), not exact counts.
- React inputs need the native value setter + `input`/`change` event
  dispatch; `<select>` likewise (`HTMLSelectElement` prototype setter).
- Tests share one app instance and run in file order — later tests must
  tolerate earlier tests' data (relative assertions, unique titles).
- The harness launches the app with `CALENDAR_REMINDERS=off` by default,
  which makes the desktop RemindersClient unavailable: `reminders.e2e.ts`
  seeds an Apple account/list/reminder straight into SQLite and asserts
  the chip and form; a real EventKit sync would replace those rows (and
  prompt for access on a developer's Mac). `launchApp(seed, { reminders:
'real' })` opts a spec into the helper — only `remindersReal.e2e.ts`,
  which is `describe.skipIf` unless `CALENDAR_E2E_REMINDERS=real`.

### CI (.github/workflows/ci.yml + ios.yml)

- `gate` (ubuntu): check + typecheck + unit tests.
- `e2e` (macos-15): desktop build → e2e suite. GUI Electron runs fine on
  macOS runners; content protection does not affect CDP automation.
- `package-smoke` (macos-26, PRs only): unsigned `package:app` + packaged-
  contents assertions — packaging failures used to surface only post-merge.
- `e2e-reminders` (macos-26): the **real** EventKit path on the desktop.
  Builds the helper, seeds the runner's per-user TCC database
  (`apps/desktop/e2e/ci/grant-reminders-tcc.sh` — named columns so the
  per-macOS column drift does not matter; every plausible client identity,
  since TCC may attribute to the helper's signing identifier, bundle id or
  path, to Electron, or to the runner's responsible process; bundle-id
  rows carry the helper's compiled csreq), then `probe-helper-access.sh` requires
  `reminders.status` = fullAccess before `remindersReal.e2e.ts` runs. The
  seed is not an Apple-supported interface: when a new runner image
  breaks it the job is red with the `access` schema, tccd's own rows and
  its log lines in the output — adjust the seed to the identity tccd
  recorded, never make the probe optional. The e2e jobs prefetch the
  Electron binary (`electron --version`) and run spec files sequentially:
  two Electron apps starting together on a small runner raced the lazy
  binary download into "CDP page target not found". Locally:
  `CALENDAR_E2E_REMINDERS=real E2E=1 pnpm exec vp test run apps/desktop/e2e/remindersReal.e2e.ts`
  (creates and deletes reminders in _your_ database).
- `ios-e2e` (macos-26): Maestro against the **EAS** dev client. CI never
  compiles the app — `apps/ios/e2e/ci/fetch-dev-client.sh` looks up the
  `development-simulator` build for the commit's native fingerprint
  (`expo-updates fingerprint:generate`, the hash `ios.yml` compares),
  requests one only if none exists, and the extracted `.app` lives in the
  Actions cache under that fingerprint, so JS-only pushes download
  nothing. `prepare-simulator.sh` boots the newest iPhone, installs, and
  pre-grants Reminders with `simctl privacy grant reminders` (supported);
  Metro on the runner serves the commit's JS. Two things made the dev
  launcher's 10 s request timeout bite on the runner and are handled
  before it is opened: the bundle is warmed through the manifest's
  `launchAsset.url` (so the request shares Metro's cache with the
  client's), and the runtime version is pinned to the computed
  fingerprint through a CI-only `app.config.js` overlay
  (`e2e/ci/app.config.ci.js`, copied after the fingerprint step) —
  with the fingerprint policy Expo CLI re-runs a full project
  fingerprint for _every_ manifest request, ~2 s on a laptop and past
  10 s on the runner. The dev client is opened on `127.0.0.1`. Two Maestro invocations: the bootstrap flow, then the rest —
  Maestro ignores `config.yaml` execution order (maestro#2231).
- `testing-build` (macos-26, main only): signed + notarized arm64 zip
  incl. the Swift model helper — macos-26 is the only runner image with
  the FoundationModels SDK. See docs/distribution.md.
- `ios.yml` (main + PRs): fingerprint-gated — TestFlight build when the
  native fingerprint changed, otherwise `eas update`; PRs get a `pr-<n>`
  preview channel.
- Log lines may stringify effect causes containing HTTP requests; effect
  redacts auth headers (`"authorization":<redacted>` — verified), so
  tokens cannot leak into CI logs this way.

### iOS e2e (Maestro, apps/ios/e2e/flows/)

Text/testID-based flows (10: launch, navigation, new-event sheet,
settings, day swipe, quick-add, create event, task lane, reminders form,
real reminders). Flows carry `tags`: everything is `ci`; the strict
`10-reminders-real.yaml` is also `ci-reminders` — it connects, creates
through EventKit and deletes with no escape hatch, so `pnpm test:e2e:ios`
excludes it (`--exclude-tags ci-reminders`) and CI includes it on a
simulator whose grant `prepare-simulator.sh` seeded. Flow 09 is the
tolerant local sibling (a no-op until the simulator has a connected
list). Maestro runs a directory's flows in a non-deterministic order and
`config.yaml`'s `executionOrder` is not honored (maestro#2231), so CI
runs the bootstrap as its own invocation and every other flow must be
independent of what ran before — the real-Reminders flow connects an
account, after which the task form defaults to the Apple list, hence
`Edit (Task|Reminder)` in flow 08. Text selectors are whole-string
regexes: a list row's label is title + swatch + check mark, so rows are
picked by `id: task-list-option`; a chip body is tapped by its full text
(`[0-9]+:[0-9]+ !!! <title>` for a timed reminder), because `.*<title>`
also matches the checkbox's "Toggle <title>" label and toggles
completion instead of opening the editor. Every flow starts with `runFlow: ../common/launch.yaml`
(launch, wait for "Today", `waitForAnimationToEnd`): React Native's
SafeAreaView applies the top inset a beat after the first paint, so an id
tap taken as soon as "Today" is visible lands ~60 pt too high — in the
status bar — on every flow. On CI, `prepare-simulator.sh` also switches
expo-dev-menu's floating "Dev tools" button off through UserDefaults
(`EXDevMenuShowFloatingActionButton`): it sits exactly over the app's
settings gear. Maestro needs a JDK on PATH (Apple's `/usr/bin/java` stub
is not one: `brew install openjdk`, then
`JAVA_HOME=/opt/homebrew/opt/openjdk`). Maestro cannot
synthesize long-press pans, so gesture behavior is covered by unit tests
on the shared math instead. Selector gotchas (each caused a real
failure): Maestro text selectors are **whole-string regexes** — prefix
text does not match, and regex metacharacters in titles must be escaped;
never select by `local-…` task ids (the op push swaps them to server ids
mid-flow) — select by title/label text; avoid non-ASCII punctuation in
typed text (XCTest typing flakiness).
