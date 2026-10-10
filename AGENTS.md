# Solunivo

Client-only Google Calendar + Tasks client that also shows the device's
Apple Calendar (EventKit) calendars and Apple Reminders: an Expo iOS app
and an Electron macOS app over a shared, Effect-v4-first TypeScript core.
No backend: data syncs directly against the Google Calendar/Tasks REST
APIs with syncToken (events) and updatedMin-watermark (tasks) polling
plus an offline-tolerant pending-op queue. On-device AI (Apple Foundation
Models + SpeechAnalyzer + Vision) powers quick-add parsing, find-a-time,
dictation and capture from text or photo.

## Monorepo map

- `packages/core` — domain types (Schema classes), the rpc contract
  (`backend.ts`), recurrence math (expand/build/edit), drag/time math,
  meeting-link + color helpers, the theme (`theme/tokens.ts`, generated
  from `brand/`, never edited; `eventTint` turns a calendar color into a
  fill/text/edge per scheme), up-next / task-inbox / agenda grouping,
  search (`search/`: accent- and case-folded every-word matching, one
  hit per series), the settings document, the mirror model. Pure; no IO.
- `packages/db` — SQLite repos (accounts/calendars/events/tasks/task_lists/
  pending_ops/sync_state/contacts/device_settings/…), the custom
  migration runner, Reactivity keys + invalidation forwarding.
- `packages/google` — REST clients for Calendar, Tasks and People
  (TokenManager auth), Gcal↔domain mapping, OAuth scopes and token stores.
- `packages/sync` — `EventMutations` (op queue + optimistic writes, event
  and task op kinds, moves and conversions), `SyncEngine` (poll/push/pull;
  tasks watermark sync; the Apple mirrors), backend rpc handlers, duplex
  rpc protocols, calendar mirrors, search, `LocalNotifications` (event
  reminders + birthday reminders, one merged OS schedule) over a platform
  `NotificationSink`.
- `packages/ai` — the on-device AI seams (`LanguageModel`,
  `SpeechToText`, `TextRecognizer`), the quick-add, find-time and
  capture prompt/normalize/parse pipelines, and the deterministic
  fixture model both e2e suites run on. Pure TypeScript; platform
  adapters live in the apps. Its one Swift source
  (`swift/OcrBridge.swift`, Vision text recognition) is symlinked into
  the desktop helper and the `solunivo-ocr` iOS Expo module like the
  other bridges.
- `packages/reminders`, `packages/apple-calendar`, `packages/contacts`,
  `packages/geo` — one seam each over a native bridge, all the same
  shape: a `Context.Service` client (`reminders.*`, `calendar.*`,
  `contacts.*`, `geo.*`), the JSON protocol shared with both native
  hosts, an in-memory fake for tests, and one Swift source under
  `swift/` symlinked into the desktop helper and the matching
  `apps/ios/modules/solunivo-*` Expo module. Reminders are mirrored into
  the tasks table; Apple calendars are mirrored and their events read
  through, never stored; contacts are read-only and in memory (feeding
  the invitee typeahead and, via `contacts.birthdays`, the birthday
  chips); geo is MapKit (typeahead, geocoding, map snapshots) — Google
  stores only location text, coordinates are derived on-device and
  mirrored into the event's private `extendedProperties`.
- `packages/agent` — the agent gateway's logic, desktop-only in use: the
  per-agent grant (`AgentPolicy`), opaque refs, the curated tool contract,
  enforced reads and planned writes over `EventMutations`, ask-first
  approvals, and the agent store (its own `agents.db`, never
  calendar.db). `callTool` is the single entry point for an agent.
- `packages/app-state` — `@effect/atom-react` atoms + React hooks
  (`useBackendMutations`, `useEventsInRangeStable`, `useSearch`, …) and
  the editor models shared by both apps.
- `apps/desktop` — Electron (Forge, vite, `vp pack` main bundle); rpc over
  an IPC frame channel; the Swift helper (`helper/`, Foundation Models +
  SpeechAnalyzer + Vision + EventKit + Contacts + MapKit over stdio;
  process owned by `electron/helperProcess.ts`); the agent gateway host
  (`electron/agent/`: Unix socket, MCP server, CLI runner) and its relay
  `solunivo-cli` (`electron/cli.ts`, a third `pack` entry in
  `vite.config.ts`).
- `apps/ios` — Expo dev client on expo-router (`app/`: native tabs
  Calendar · Tasks · Search (a stack whose `Stack.SearchBar` is the system
  search field), Settings as a modal holding its own stack of pages
  (`app/settings/`), `+native-intent.tsx` keeps share/OAuth URLs off the
  router; `src/ui/EditorHost.tsx` owns every sheet); `@expo/ui` for
  drop-in native controls; zero-hop direct backend; @react-native-ai/apple
  for on-device model access; the local Expo modules under `modules/`;
  `expo-maps` draws the editor map.
- `brand/` — SVG masters, logos, fonts and tokens; `pnpm brand:build`
  (macOS) regenerates the committed app icons, `tokens.css` (the desktop
  imports it; `App.css` maps the variables to Tailwind utilities — the
  renderer's only colors, `themeClasses.test.ts` fails on Tailwind's own
  palette — and `data-theme` on `<html>` follows the OS appearance) and
  `packages/core/src/theme/tokens.ts` (iOS reads it through `useTheme`),
  and CI fails on stale exports via `pnpm brand:check`. Edit
  `tokens/tokens.json` and the masters, never the generated files.

Rules of thumb: I/O, orchestration and validation are Effect (services +
Layers, no thrown exceptions in shared code); pure math (layout,
recurrence) and React components are plain TS. Shared packages ship raw TS
source via `exports: ./src/index.ts` — no build step.

## Commands

The gate — `pnpm check`, `pnpm typecheck`, `pnpm test` — must be green
before any commit; `pnpm fix` (`vp check --fix`) applies lint and format
fixes. A pre-commit hook (`vp config`, installed by `pnpm install`) runs
`vp staged` and commits the whole index, so split commits by staging
deliberately.

- `pnpm test` — vitest via vite-plus, unit tests against in-memory
  SQLite; Effect code uses `@effect/vitest` with TestClock.
- `pnpm --filter @calendar/desktop build && pnpm test:e2e` — the desktop
  e2e suite (`apps/desktop/e2e/`, CDP against the built Electron app in
  an isolated profile; the windows open at the back and take CDP input
  only). Spec inventory, launch options and flakiness rules:
  `docs/google-sync-and-testing.md`, "Desktop e2e".
- `pnpm test:e2e:ios` — Maestro flows (`apps/ios/e2e/flows/`) against
  the installed dev client (`pnpm --filter @calendar/ios ios`, or the EAS
  simulator build — `docs/distribution.md`) with Metro running
  (`pnpm --filter @calendar/ios start`). Needs the Maestro CLI
  (`brew install mobile-dev-inc/tap/maestro`) and a JDK on PATH
  (`brew install openjdk`, then `JAVA_HOME=$(brew --prefix openjdk)`).
  Start Metro with `EXPO_PUBLIC_CALENDAR_GOOGLE=fixture` for the Google
  halves of the flows. Flow conventions: `docs/google-sync-and-testing.md`,
  "iOS e2e".
- `GOOGLE_LIVE=1 pnpm exec vp test run` — the live Google suite
  (`packages/sync/src/live/*.live.ts`) against the dedicated test account
  over the real API; desktop
  `E2E=1 CALENDAR_E2E_GOOGLE=live pnpm exec vp test run apps/desktop/e2e/googleLive.e2e.ts`;
  iOS `pnpm --filter @calendar/ios test:e2e:live`. Setup and isolation
  rules: `docs/google-sync-and-testing.md`, "Live Google suite".
- `pnpm dev:desktop` — renderer dev server, paired with
  `pnpm --filter @calendar/desktop dev:app`. A run from source is the
  **dev variant** and shares nothing with an installed Solunivo.app: its
  own profile (`~/Library/Application Support/@calendar/desktop`:
  `calendar.db`, `agents.db`, tokens), settings file
  (`~/.solunivo/solunivo-dev.jsonc`), agent socket (`agent-dev.sock`) and
  MCP server name (`solunivo-dev`) — so it can stay signed in to test
  accounts while the installed app holds the real ones. Apple data is
  the exception: Calendar, Reminders and Contacts are the Mac's. To keep
  a dev run away from them (and from sending a second copy of every
  reminder), start it with `CALENDAR_APPLE_CALENDAR=off
  CALENDAR_REMINDERS=off CALENDAR_CONTACTS=off CALENDAR_NOTIFICATIONS=off`.
- `pnpm ios` — `expo run:ios` on the simulator (the dev variant;
  `pnpm --filter @calendar/ios prebuild` regenerates `ios/`).
- `pnpm --filter @calendar/desktop build:helper` — build the Swift helper
  (needs the macOS 26 SDK; `make` / `package:app` run it automatically).
- `pnpm --filter @calendar/desktop package:app` — unsigned .app via Forge
  (signing/notarization activate via `APPLE_*` env vars);
  `pnpm --filter @calendar/desktop make` — zipped distributable.
- `SOLUNIVO_AGENT_TOKEN=… node apps/desktop/dist-electron/cli.mjs <tool> [--flag value]`
  — the agent CLI against a running dev app (`mcp` serves MCP over stdio,
  `tools` lists the schemas); the packaged app ships it as
  `Solunivo.app/Contents/Resources/solunivo-cli`.
- `pnpm brand:build` / `pnpm brand:check` — regenerate / verify the brand
  exports (macOS only: needs `iconutil`).
- `pnpm reset:local` — wipe every local store on this Mac (both desktop
  variants, keychain keys, e2e profiles, the iOS app on booted
  simulators); see README.

## Hard rules (each learned the hard way — details in docs/)

- Effect is pinned exactly to **4.0.1** (all `effect*` via catalog — the
  rpc/sql/http/reactivity modules are `@stability unstable` and may break
  in a minor). Use `Effect.forkChild`/`forkDetach`/`forkIn` — `Effect.fork`
  and `forkDaemon` do not exist. `Context.Service` is two-stage:
  `class X extends Context.Service<X, Shape>()('id')`. `Layer.effect` is
  curried: `Layer.effect(Tag)(effect)`. `Schema.Literals` takes an array.
  The Reactivity class + `layer` live at
  `effect/reactivity/Reactivity` (deep import).
- Metro (iOS) cannot parse effect's `Migrator` or barrels re-exporting it:
  keep the custom `runMigrations` (`packages/db/src/migrate.ts`) and deep
  imports (`effect/sql/SqlClient`,
  `@effect/sql-sqlite-react-native/SqliteClient`).
- Electron main: never top-level-await `app.whenReady()` — 'ready' fires
  only after module evaluation, so it deadlocks. Promise-chain it
  (`apps/desktop/electron/main.ts`).
- Desktop SQLite is Node's built-in `node:sqlite` (via
  `@effect/sql-sqlite-node`) — no native module, no Electron-ABI
  rebuilds. The whole better-sqlite3 apparatus is retired.
- Oxlint enforces alphabetically sorted object keys/interface members —
  write literals sorted or `vp check` fails.
- Window-level concerns (screen privacy, logging, open-external, the five
  `model:*` AI-helper channels, the `reminders:*` / `contacts:*` /
  `appleCalendar:*` permission-status channels, `settings:open`,
  `settingsFile:*`, `auth:cancel` (stops a sign-in waiting on the
  browser), `notifications:take` (the event reminder clicked last — a
  ref; the event itself is read over rpc) and `agents:*`) use plain
  preload IPC; calendar data — reminders, Apple events and contact rows
  included — goes through the typed rpc seam only.
- The desktop has two windows on one renderer bundle: the calendar and
  Settings (`#settings/<pane>`, App menu › Settings… / ⌘,, one at most).
  Each is its own rpc client. Find the main window through `windows.ts`
  (`showMainWindow` / `hasMainWindow`), never `getAllWindows()[0]`;
  broadcasts go to all windows. The agent approval dialog, the conflict
  banner and the dropped-change toast are mounted in the main window
  only.
- Tasks and events are provider-dispatched: Google goes through the
  pending-op queue; Apple writes EventKit synchronously (Reminders mirror
  the result, Apple Calendar events are read through and never stored).
  A field the provider cannot hold (Reminders-only fields on a Google
  list; guests, RSVP or an EXDATE/BYHOUR rule on an Apple event) fails
  with `UnsupportedForProviderError` — never drop it silently. Moving an
  event across accounts/providers is copy-then-delete and drops guests,
  after the UI confirmed `previewMove`'s loss.
- Calendar mirrors (`packages/sync/src/mirrors.ts`, core `mirror/`) are the
  one exception to two rules above: their Google copies are written
  straight through the REST client under the engine's gate, never through
  the pending-op queue (copies are derived — the next run recomputes what
  did not land, and the queue would list every copy as an unsynced
  change), and a copy is built from an allow-list of fields, so leaving a
  field out is the point, not a silent drop. A copy carries a marker (a
  derived Google id plus the private `solunivo.mirror` property; an opaque
  `x-solunivo-mirror:` URL on Apple — never register that scheme) and is
  hidden from every read the UI, find-a-time, search, notifications and
  agents share (`EventRepo.getWindow`, the Apple read-through). A mirror
  runs on a device only when every source and the destination resolve
  there, the Google data was pulled minutes ago and no source holds an
  unsynced edit; definitions travel in the settings document, on/off and
  status stay in `mirrors.local`. See docs/architecture.md → Calendar
  mirrors.
- Two synthetic `provider: 'apple'` accounts exist (`apple-reminders`,
  `apple-calendar`): branch with `isAppleRemindersAccount` /
  `isAppleCalendarAccount`, never on `provider === 'apple'` alone.
- The e2e harness sets `CALENDAR_REMINDERS=off`, `CALENDAR_CONTACTS=off`,
  `CALENDAR_APPLE_CALENDAR=off` and `CALENDAR_GEO=off`: seeded Apple rows
  must never be replaced by a real EventKit sync, no bridge may trigger a
  TCC prompt or read a developer's data, and no run may depend on
  MapKit's network. Apple events come from a fixture
  (`CALENDAR_APPLE_CALENDAR=fixture`), since nothing stores them. Google
  is real by default (a seeded account has no token, so writes stay
  queued); `CALENDAR_GOOGLE=fixture` (desktop) /
  `EXPO_PUBLIC_CALENDAR_GOOGLE=fixture` (iOS bundle, on in CI) swaps in the
  in-process fake API with a signed-in fixture account. The on-device
  model is real by default too; `CALENDAR_MODEL=fixture` (desktop, a
  spec's `model: 'fixture'`) / `EXPO_PUBLIC_CALENDAR_MODEL=fixture` (iOS
  bundle, on in CI) answer with the deterministic model and text
  recognizer from `@calendar/ai` instead. `…=live` signs
  the real API in as the dedicated live test account — only the opt-in
  live suites use it (`GOOGLE_LIVE=1` Node files, `CALENDAR_E2E_GOOGLE=live`
  desktop spec, `apps/ios/e2e/live` flows; `google-live.yml` nightly),
  never `pnpm test` / `test:e2e` / `test:e2e:ios`. Live tests create
  their own `e2e-<ts>-<runTag>` calendars and lists (one set per job —
  Google caps calendar creation per day) and assert only on their own
  ids; guest mail is muted (`GuestNotifications`).
- The settings document (`SettingsDocument`, Export/Import and the
  desktop's watched `~/.solunivo/solunivo.jsonc` — `solunivo-dev.jsonc`
  for a run from source) never holds tokens or secrets: accounts are a
  sign-in checklist (kind + email + visibility), an unknown Google
  account imports as `reauth_required`, Apple accounts are never
  connected by an import, and an import never removes anything. The
  desktop e2e harness always points `CALENDAR_SETTINGS_FILE` under its
  temp profile — HOME is not isolated, a run must never touch a
  developer's real file.
- Other agents reach the app only through the agent gateway
  (`packages/agent` `callTool`, hosted in `apps/desktop/electron/agent/`),
  never the rpc seam: nothing below the UI checks a caller or a
  permission, so the gateway enforces everything. Before authorizing a
  write it resolves the item's real container (`resolve.ts`) — EventKit
  and Reminders address items by id alone and ignore the calendar/list a
  caller names. A calendar the grant hides answers NotFound, never
  PermissionDenied. Grants live in `agents.db` and are edited only over
  `agents:*` IPC: never part of `SettingsDocument`, never importable. An
  agent token is shown once and stored only as its SHA-256. Ask-first
  approval is given in the app, never via MCP elicitation; it re-plans
  the write from the stored input and runs it only if the plan's summary
  equals the one the user approved — so a summary must describe the
  whole write and is never shortened (cap input sizes instead). The relay
  runs under `ELECTRON_RUN_AS_NODE`, so the RunAsNode fuse must stay
  enabled. The desktop e2e harness always points `CALENDAR_AGENT_SOCKET`
  under its temp profile — a run must never listen in a developer's
  `~/.solunivo`. See docs/agent-gateway.md.
- Two variants per platform, production and dev, that run side by side —
  never a third. Desktop: the packaged app vs. a run from source,
  switched on `app.isPackaged`, which picks the settings file
  (`solunivo.jsonc` / `solunivo-dev.jsonc`), the agent socket
  (`agent.sock` / `agent-dev.sock`) and the MCP entry's name (`solunivo` /
  `solunivo-dev`); userData differs by itself. iOS: `com.solunivo.app`
  (TestFlight) vs. `com.solunivo.app.dev` (the dev client), switched by
  `APP_VARIANT=development` in `apps/ios/app.config.js`. Unset means
  production, so release jobs set nothing; every dev consumer sets it
  (eas.json's development and `e2e-simulator` profiles, the
  `start`/`ios`/`prebuild` scripts, the iOS e2e jobs,
  `check-devclient.mjs`). The share extension and its app group derive
  from the bundle id (`<id>.share`, `group.<id>`, pinned in
  `plugins/withShareExtension.cjs`), so they differ per variant too.
  CI's `ios-e2e` drives the dev variant as a Release build with the
  commit's JS embedded (`e2e/ci/repack-app.sh`, expo-updates switched
  off), in two shards and without Metro; the dev client with Metro is
  for local runs and the live suite. The variants have different native
  fingerprints: compute one under the `APP_VARIANT` of the build it must
  match. Maestro flows and `simctl` grants name the dev id. Anything two
  installed apps would both claim (a URL scheme, an OAuth client, a file
  under `~/.solunivo`) must differ per variant. Apple data is the
  device's and is shared by both. Keep `app.config.js` plain CommonJS:
  Expo evaluates it on every manifest request, and a `.ts` config is
  transpiled with Babel each time — on CI that pushed the dev client's
  first request past its 10 s budget. Any `apps/ios/package.json` script
  edit moves the native fingerprint too. See docs/distribution.md.
- Event coordinates are only valid while `geo.source` matches the
  location text (`geoMatches`); every local write goes through
  `withConsistentGeo`, and an update PATCH touches the private geo keys
  only when the record has coordinates (values) or the edit dropped them
  (`PendingOp.geoCleared` → nulls). Only picked or already-mirrored
  coordinates are pushed; open-time lookups of free text stay on the
  device. Geocoding runs on demand, never during sync.
- The desktop helper's main thread runs `RunLoop.main.run()`, not
  `dispatchMain()`: MKLocalSearchCompleter never calls back without
  run-loop timers, and a main thread blocked in `readLine()` never
  delivers `EKEventStoreChanged` (stdin is read on a background thread).
- Dependencies: `effect*` exact through the catalog (Dependabot ignores
  them); `react` tilde-pinned to the React Native renderer's version; the
  Expo-bound React Native stack moves only with the SDK (`npx expo install
  --check` is the oracle); `vitest` equals the version vite-plus bundles.
  The 2-day `minimumReleaseAge` gate is never bypassed, and a
  `trustPolicyExclude` entry is added only by exact version after an audit
  (the comments in `pnpm-workspace.yaml` say how).
- Secrets: `google-oauth.local.json` is gitignored — never commit OAuth
  client config. OAuth tokens live only in TokenStore
  (Keychain/safeStorage), never in SQLite.
- Workflow: one commit per task on a `todo/<slug>` branch → PR to `main` →
  CI green (gate + macOS e2e) → Nik merges. Direct pushes to main are
  blocked. A shipped item leaves `todo.md` and gets a short record in
  `docs/decisions.md` under its area: the decision, the alternatives
  rejected, what it leaves open, and the PR for the detail — ten lines at
  most. The mechanism goes in the current-state doc it belongs to, never
  in the log, and the test list goes nowhere.
- e2e tests must be date- and scroll-independent: seed relative to "today
  minus N days", locate elements via `scrollIntoView` (harness `locate`),
  and assert relative counts. Desktop specs open an event through the
  harness's `openInspector` / `openEditor` (a grid click shows the
  inspector; Edit opens the editor) and locate by `data-testid`, never by
  a Tailwind class or a computed color (`data-color` carries a block's
  calendar hex). Test email addresses are made up (`@example.com`), never
  a real person's. See docs/google-sync-and-testing.md.

## Deep docs

- `docs/architecture.md` — data flow, op queue, sync engine, Apple
  Calendar, mirrors, search, recurring model, platform seams.
- `docs/effect-v4-notes.md` — the Effect v4 gotcha catalog (symptom → fix).
- `docs/google-sync-and-testing.md` — verified Google and EventKit
  semantics + testing conventions, CI and flakiness lessons.
- `docs/distribution.md` — CI build/signing pipeline, TestFlight, EAS
  updates, the two variants, dev clients.
- `docs/agent-gateway.md` — MCP/CLI access for other agents: tools,
  permission levels, ask-first, transport, storage, threat model.
- `todo.md` — ranked backlog (tiers by impact, one PR per item).
  `docs/decisions.md` — decision log: every shipped item's `[x]` entry
  with the design decisions it settled.
