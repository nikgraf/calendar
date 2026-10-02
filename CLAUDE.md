# CLAUDE.md

Client-only Google Calendar + Tasks client, also showing the device's
Apple Calendar (EventKit) calendars (no backend): Expo iOS app +
Electron macOS app over a shared, Effect-v4-first TypeScript core. Data
syncs directly against the Google Calendar/Tasks REST APIs with syncToken
(events) and updatedMin-watermark (tasks) polling plus an offline-tolerant
pending-op queue. On-device AI (Apple Foundation Models + SpeechAnalyzer)
powers quick-add parsing, find-a-time, and dictation.

## Monorepo map

- `packages/core` — domain types (Schema classes), rpc contract
  (`backend.ts`), recurrence math (expand/build/edit), drag/time math,
  meeting-link + color helpers. Pure; no IO.
- `packages/db` — SQLite repos (accounts/calendars/events/tasks/task_lists/
  pending_ops/sync_state), custom migration runner, Reactivity keys +
  invalidation forwarding.
- `packages/google` — REST clients for Calendar and Tasks (TokenManager
  auth), Gcal↔domain mapping, OAuth token stores.
- `packages/sync` — `EventMutations` (op queue + optimistic writes, event
  and task op kinds), `SyncEngine` (poll/push/pull; tasks watermark sync),
  backend rpc handlers, duplex rpc protocols, `LocalNotifications`
  (event reminders + birthday reminders, one merged OS schedule) over a
  platform `NotificationSink`.
- `packages/ai` — model-provider seam (`ModelProvider`/`SpeechProvider`
  interfaces), quick-add + find-time prompt/normalize/parse pipelines.
  Pure; platform adapters live in the apps.
- `packages/reminders` — Apple Reminders seam: the `RemindersClient`
  service, the JSON protocol shared with both native bridges, EventKit
  ↔ `TaskRecord` mapping, and an in-memory fake for tests. The one Swift
  source (`swift/RemindersBridge.swift`) is symlinked into the desktop
  helper and the iOS Expo module.
- `packages/apple-calendar` — Apple Calendar (EventKit events) seam,
  same shape as reminders: `AppleCalendarClient` (`calendar.*`), the JSON
  protocol, an in-memory fake with EventKit span semantics, and one Swift
  source (`swift/AppleCalendarBridge.swift`) symlinked into both native
  hosts. Calendars are mirrored; events are read through, never stored.
- `packages/contacts` — device address book seam, same shape as
  reminders but read-only: `ContactsClient` (`contacts.status` /
  `requestAccess` / `snapshot`), the JSON protocol, an in-memory fake,
  and the one Swift source (`swift/ContactsBridge.swift`, CNContactStore)
  symlinked into both native hosts. Feeds the invitee typeahead and, via
  `contacts.birthdays`, the birthday chips.
- `packages/geo` — MapKit seam, same shape again: `GeoClient`
  (`geo.search` typeahead, `geo.resolve` geocoding, `geo.snapshot` map
  image), the JSON protocol, an in-memory fake, and one Swift source
  (`swift/GeoBridge.swift`) symlinked into both native hosts. Google
  stores only location text; coordinates are derived on-device and
  mirrored into the event's private `extendedProperties`.
- `packages/agent` — the agent gateway's logic, desktop-only in use: the
  per-agent grant (`AgentPolicy`), opaque refs, the curated tool contract,
  enforced reads and planned writes over `EventMutations`, ask-first
  approvals, and the agent store (its own `agents.db`, never
  calendar.db). `callTool` is the single entry point for an agent.
- `packages/app-state` — `@effect/atom-react` atoms + React hooks
  (`useBackendMutations`, `useEventsInRangeStable`, …).
- `apps/desktop` — Electron (Forge, vite, tsdown main bundle); rpc over an
  IPC frame channel; Swift helper (`helper/`, Foundation Models +
  SpeechAnalyzer + EventKit `reminders.*` / `calendar.*` + Contacts
  `contacts.*` over
  stdio; process owned by
  `electron/helperProcess.ts`); the agent gateway host
  (`electron/agent/`: Unix socket, MCP server, CLI runner) and its relay
  `solunivo-cli` (`electron/cli.ts`, a third tsdown entry). `apps/ios` —
  Expo dev client; zero-hop direct backend; @react-native-ai/apple for on-device model access;
  local Expo modules `modules/solunivo-reminders` (EventKit),
  `modules/solunivo-apple-calendar` (EventKit events),
  `modules/solunivo-contacts` (CNContactStore) and `modules/solunivo-geo`
  (MapKit); `expo-maps` draws the editor map.
- `brand/` — SVG masters, logos, fonts and tokens; `pnpm brand:build`
  (macOS) regenerates the committed app icons and `tokens.css`, and CI
  fails on stale exports via `pnpm brand:check`. Edit the masters, never
  the generated ICNS/PNG.

## Commands (gate must be green before any commit)

- `pnpm check` · `pnpm typecheck` · `pnpm test` (unit, in-memory sqlite)
- `pnpm --filter @calendar/desktop build && pnpm test:e2e` (CDP e2e suite)
- `pnpm test:e2e:ios` (Maestro; needs CLI + dev client + Metro)
- `pnpm exec vp fmt` / `vp check --fix` for formatting/lint fixes

## Hard rules (each learned the hard way — details in docs/)

- Effect is pinned to **4.0.0-rc.115** (v4 pre-release, all `effect*` via
  catalog). Use `Effect.forkChild`/`forkDetach`/`forkIn` — `Effect.fork`
  and `forkDaemon` do not exist. `Context.Service` is two-stage:
  `class X extends Context.Service<X, Shape>()('id')`. `Layer.effect` is
  curried: `Layer.effect(Tag)(effect)`. `Schema.Literals` takes an array.
  The Reactivity class + `layer` live at
  `effect/unstable/reactivity/Reactivity` (deep import).
- Metro (iOS) cannot parse effect's `Migrator` or barrels re-exporting it:
  keep the custom `runMigrations` (`packages/db/src/migrate.ts`) and deep
  imports (`effect/unstable/sql/SqlClient`,
  `@effect/sql-sqlite-react-native/SqliteClient`).
- Electron main: never top-level-await `app.whenReady()` — 'ready' fires
  only after module evaluation, so it deadlocks. Promise-chain it
  (`apps/desktop/electron/main.ts`).
- Desktop SQLite is Node's built-in `node:sqlite` (via
  `@effect/sql-sqlite-node` since effect 4.0.0-rc) — no native module, no
  Electron-ABI rebuilds. The whole better-sqlite3 apparatus is retired.
- Oxlint enforces alphabetically sorted object keys/interface members —
  write literals sorted or `vp check` fails.
- Window-level concerns (screen privacy, logging, open-external, the four
  `model:*` AI-helper channels, the `reminders:*` / `contacts:*` /
  `appleCalendar:*` permission-status channels, and `agents:*`) use plain
  preload IPC;
  calendar data — reminders, Apple events and contact rows included — goes
  through the typed rpc seam only.
- Tasks and events are provider-dispatched: Google goes through the
  pending-op queue; Apple writes EventKit synchronously (Reminders mirror
  the result, Apple Calendar events are read through and never stored).
  A field the provider cannot hold (Reminders-only fields on a Google
  list; guests, RSVP or an EXDATE/BYHOUR rule on an Apple event) fails
  with `UnsupportedForProviderError` — never drop it silently. Moving an
  event across accounts/providers is copy-then-delete and drops guests,
  after the UI confirmed `previewMove`'s loss.
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
  `EXPO_PUBLIC_CALENDAR_GOOGLE=fixture` (iOS Metro, on in CI) swaps in the
  in-process fake API with a signed-in fixture account. `…=live` signs
  the real API in as the dedicated live test account — only the opt-in
  live suites use it (`GOOGLE_LIVE=1` Node files, `CALENDAR_E2E_GOOGLE=live`
  desktop spec, `apps/ios/e2e/live` flows; `google-live.yml` nightly),
  never `pnpm test` / `test:e2e` / `test:e2e:ios`. Live tests create
  their own `e2e-<ts>-<runTag>` calendars and lists and assert only on
  their own ids; guest mail is muted (`GuestNotifications`).
- The settings document (`SettingsDocument`, Export/Import and the
  desktop's watched `~/.solunivo/solunivo.jsonc` — `solunivo-dev.jsonc`
  for a run from source) never holds tokens or
  secrets: accounts are a sign-in checklist (kind + email + visibility),
  an unknown Google account imports as `reauth_required`, Apple accounts
  are never connected by an import, and an import never removes anything.
  The desktop e2e harness always points `CALENDAR_SETTINGS_FILE` under
  its temp profile — HOME is not isolated, a run must never touch a
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
  agent token is shown once and stored only as its SHA-256 (a hash is not
  a usable token; the TokenStore rule below covers OAuth tokens).
  Ask-first approval is given in the app, never via MCP elicitation; it
  re-plans the write from the stored input and runs it only if the plan's
  summary equals the one the user approved — so a summary must describe
  the whole write and is never shortened (cap input sizes instead). The relay runs under
  `ELECTRON_RUN_AS_NODE`, so the RunAsNode fuse must stay enabled. The
  desktop e2e harness always points `CALENDAR_AGENT_SOCKET` under its
  temp profile — a run must never listen in a developer's `~/.solunivo`.
  See docs/agent-gateway.md.
- Two variants per platform, production and dev, that run side by side —
  never a third. Desktop: the packaged app vs. a run from source,
  switched on `app.isPackaged`, which picks the settings file
  (`solunivo.jsonc` / `solunivo-dev.jsonc`), the agent socket
  (`agent.sock` / `agent-dev.sock`) and the MCP entry's name (`solunivo` /
  `solunivo-dev`); userData differs by itself. iOS: `com.solunivo.app`
  (TestFlight) vs. `com.solunivo.app.dev` (the dev client), switched by
  `APP_VARIANT=development` in `apps/ios/app.config.ts`. Unset means
  production, so release jobs set nothing; every dev consumer sets it
  (eas.json's development profiles, the `start`/`ios`/`prebuild` scripts,
  the iOS e2e jobs, `check-devclient.mjs`). The variants have different
  native fingerprints: compute one under the `APP_VARIANT` of the build it
  must match. Maestro flows and `simctl` grants name the dev id. Anything
  two installed apps would both claim (a URL scheme, an OAuth client, a
  file under `~/.solunivo`) must differ per variant. Apple data is the
  device's and is shared by both. See docs/distribution.md.
- Event coordinates are only valid while `geo.source` matches the
  location text (`geoMatches`); every local write goes through
  `withConsistentGeo`, and an update PATCH touches the private geo keys
  only when the record has coordinates (values) or the edit dropped them
  (`PendingOp.geoCleared` → nulls). Only picked or already-mirrored
  coordinates are pushed; open-time lookups of free text stay on the
  device. Geocoding runs on demand, never during sync.
- The desktop helper's main thread runs `RunLoop.main.run()`, not
  `dispatchMain()`: MKLocalSearchCompleter never calls back without
  run-loop timers.
- Secrets: `google-oauth.local.json` is gitignored — never commit OAuth
  client config. OAuth tokens live only in TokenStore
  (Keychain/safeStorage), never in SQLite.
- Workflow: one commit per task on a `todo/<slug>` branch → PR to `main` →
  CI green (gate + macOS e2e) → Nik merges. Direct pushes to main are
  blocked.
- e2e tests must be date- and scroll-independent: seed relative to "today
  minus N days", locate elements via `scrollIntoView` (harness `locate`),
  and assert relative counts. See docs/google-sync-and-testing.md.

## Deep docs

- `docs/architecture.md` — data flow, op queue, sync engine, recurring
  model.
- `docs/effect-v4-notes.md` — the v4-beta gotcha catalog (symptom → fix).
- `docs/google-sync-and-testing.md` — verified Google API semantics +
  testing conventions and flakiness lessons.
- `docs/distribution.md` — CI build/signing pipeline, TestFlight, EAS
  updates, fingerprint-gated iOS publishing.
- `docs/agent-gateway.md` — MCP/CLI access for other agents: tools,
  permission levels, ask-first, transport, storage, threat model.
- `AGENTS.md` — command reference. `todo.md` — ranked backlog (tiers by
  impact, one PR per item). `docs/decisions.md` — decision log: every
  shipped item's `[x]` entry with the design decisions it settled.
