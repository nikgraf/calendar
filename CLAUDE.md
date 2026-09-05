# CLAUDE.md

Client-only Google Calendar + Tasks client (no backend): Expo iOS app +
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
  backend rpc handlers, duplex rpc protocols.
- `packages/ai` — model-provider seam (`ModelProvider`/`SpeechProvider`
  interfaces), quick-add + find-time prompt/normalize/parse pipelines.
  Pure; platform adapters live in the apps.
- `packages/reminders` — Apple Reminders seam: the `RemindersClient`
  service, the JSON protocol shared with both native bridges, EventKit
  ↔ `TaskRecord` mapping, and an in-memory fake for tests. The one Swift
  source (`swift/RemindersBridge.swift`) is symlinked into the desktop
  helper and the iOS Expo module.
- `packages/contacts` — device address book seam, same shape as
  reminders but read-only: `ContactsClient` (`contacts.status` /
  `requestAccess` / `snapshot`), the JSON protocol, an in-memory fake,
  and the one Swift source (`swift/ContactsBridge.swift`, CNContactStore)
  symlinked into both native hosts. Feeds the invitee typeahead.
- `packages/app-state` — `@effect/atom-react` atoms + React hooks
  (`useBackendMutations`, `useEventsInRangeStable`, …).
- `apps/desktop` — Electron (Forge, vite, tsdown main bundle); rpc over an
  IPC frame channel; Swift helper (`helper/`, Foundation Models +
  SpeechAnalyzer + EventKit `reminders.*` + Contacts `contacts.*` over
  stdio; process owned by
  `electron/helperProcess.ts`). `apps/ios` — Expo dev client; zero-hop
  direct backend; @react-native-ai/apple for on-device model access;
  local Expo modules `modules/solunivo-reminders` (EventKit) and
  `modules/solunivo-contacts` (CNContactStore).

## Commands (gate must be green before any commit)

- `pnpm check` · `pnpm typecheck` · `pnpm test` (unit, in-memory sqlite)
- `pnpm --filter @calendar/desktop build && pnpm test:e2e` (CDP e2e suite)
- `pnpm test:e2e:ios` (Maestro; needs CLI + dev client + Metro)
- `pnpm exec vp fmt` / `vp check --fix` for formatting/lint fixes

## Hard rules (each learned the hard way — details in docs/)

- Effect is pinned to **4.0.0-rc.111** (v4 pre-release, all `effect*` via
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
  `model:*` AI-helper channels, and the `reminders:*` / `contacts:*`
  permission-status channels) use plain preload IPC; calendar data —
  reminders and contact rows included — goes
  through the typed rpc seam only.
- Tasks are provider-dispatched: Google lists go through the pending-op
  queue (server-assigned ids, temp-id/adopt protocol); Apple lists write
  EventKit synchronously and mirror the result. Reminders-only fields on
  a Google list fail with `UnsupportedForProviderError` — never drop
  them silently.
- The e2e harness sets `CALENDAR_REMINDERS=off` and `CALENDAR_CONTACTS=off`:
  seeded Apple rows must never be replaced by a real EventKit sync, and
  neither bridge may trigger a TCC prompt or read a developer's data.
- Secrets: `google-oauth.local.json` is gitignored — never commit OAuth
  client config. Tokens live only in TokenStore (Keychain/safeStorage),
  never in SQLite.
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
- `AGENTS.md` — command reference. `todo.md` — roadmap and decision log
  (done-entries record design decisions).
