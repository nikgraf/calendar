# Solunivo

A Fantastical-style Google Calendar client: iOS app (Expo SDK 57, React Native) and macOS desktop app (Electron 43, React DOM), sharing a TypeScript core. Client-only — no backend; the apps talk directly to the Google Calendar and Google Tasks REST APIs and sync via incremental sync tokens (events) / updatedMin watermarks (tasks) + polling.

## Architecture

Effect v4 (rc pre-release, all `effect*` packages pinned to one version via the pnpm catalog) is the foundation for all non-UI code:

- `packages/core` — Schema domain models, tagged errors, Temporal time helpers (`@js-temporal/polyfill`), rrule-temporal recurrence expansion, pure layout engine, drag/time math, the `findSlots` free-time solver (`src/scheduling/`), and `AppBackendRpcs` — the effect rpc group that is the platform seam (request/response methods + a `stream: true` invalidations rpc).
- `packages/google` — TokenStore/TokenManager services, GoogleCalendarClient + GoogleTasksClient over `effect/unstable/http`, Schedule-based retry.
- `packages/db` — repository services with Schema row codecs over a hand-rolled migration runner (`src/migrate.ts` — effect's Migrator is Metro-incompatible); Reactivity keys (`accounts`, `calendars`, `events` + `events:<calendarId>`, `pendingOps`, `tasks`, `taskLists`, `notice:conflict`) for invalidation.
- `packages/sync` — SyncEngine service: per-account sync fibers, pending-op queue (9 op kinds incl. tasks), typed sync errors; Google Tasks watermark sync; Apple Reminders windowed mirror (`syncReminders`) and provider-dispatched task mutations (`reminderMutations.ts`).
- `packages/ai` — provider seam + prompt/normalize pipelines for quick-add parsing and find-a-time; platform adapters (Swift helper on desktop, @react-native-ai/apple on iOS) live in the apps.
- `packages/reminders` — Apple Reminders: `RemindersClient` service over one JSON protocol (`reminders.status/requestAccess/listLists/list/create/update/setCompleted/delete`), EventKit ↔ `TaskRecord` mapping, in-memory fake. Native side: `swift/RemindersBridge.swift`, symlinked into `apps/desktop/helper` and the local Expo module `apps/ios/modules/solunivo-reminders`.
- `packages/app-state` — shared atoms (`makeBackendAtoms`): reads subscribe to Reactivity keys (`accounts`/`calendars`/`events`), mutations are `runtime.fn` atoms invalidating those keys; backend-side invalidations arrive through the forwarding bridge (`packages/db/src/reactivityForward.ts` → IPC on desktop, in-process on iOS). React consumes them via `@effect/atom-react`.
- `apps/desktop` — Electron: backend Layer stack in main, served as an effect RpcServer over a preload frame channel (`duplexServerProtocol`/`duplexClientProtocol` in `packages/sync/src/rpcDuplex.ts`, ndjson serialization); the renderer holds an RpcClient that structurally satisfies `BackendClient`, and invalidation keys arrive as a typed rpc stream. Forge for packaging, tsdown builds main/preload, vite-plus (`vp`) serves the renderer.
- `apps/ios` — Expo dev client; in-process runtime (no rpc hop), `@effect/sql-sqlite-react-native` (op-sqlite), RN renderers on the shared layout engine.

Rules of thumb: I/O, orchestration, and validation are Effect (services + Layers, no thrown exceptions in shared code); pure math (layout, recurrence) and React components are plain TS. Shared packages ship raw TS source via `exports: ./src/index.ts` — no build step.

## Commands

- `pnpm check` / `pnpm fix` — lint + format (Oxlint/Oxfmt via vite-plus)
- `pnpm test` — vitest (via vite-plus); Effect code uses `@effect/vitest` with TestClock
- `pnpm test:e2e` — desktop e2e suite (`apps/desktop/e2e/`): launches the built Electron app with an isolated profile (`CALENDAR_USERDATA`) and drives it over CDP — covers rendering, view switching, editor CRUD, drag move/resize/cancel, recurring editing (override drag, scope selector, series split, occurrence delete), visibility toggles, month view, task lane + task editor, and the ⌘K command bar (fake model provider). Requires `pnpm --filter @calendar/desktop build` first
- `pnpm test:e2e:ios` — Maestro flows (`apps/ios/e2e/flows/`, 9 flows: launch, navigation, new-event sheet, settings, day swipe, quick-add, create event, task lane, reminders form) against the dev-client build on a booted simulator. Requires the Maestro CLI (`brew install mobile-dev-inc/tap/maestro`), the app installed (`pnpm --filter @calendar/ios ios`), and Metro running (`pnpm --filter @calendar/ios start`)
- `pnpm typecheck` — `tsc --noEmit` in every workspace package
- `pnpm dev:desktop` — renderer dev server (pair with `pnpm --filter @calendar/desktop dev:app`)
- `pnpm ios` — Expo run on iOS simulator
- `pnpm --filter @calendar/desktop build:helper` — build the Swift model helper (needs the macOS 26 SDK; `make`/`package:app` run it automatically)
- `pnpm --filter @calendar/desktop package:app` — unsigned .app via Forge (signing/notarization activate via APPLE\_\* env vars); `pnpm --filter @calendar/desktop make` — zipped distributable
- CI ships a signed+notarized arm64 testing zip on every main push (Actions artifact) — see `docs/distribution.md`

The full product plan lives in the repo owner's plan file; milestone tracking in session tasks.

## Deep docs

Start with `CLAUDE.md` (rules + map), then `docs/architecture.md`,
`docs/effect-v4-notes.md`, and `docs/google-sync-and-testing.md`.
`todo.md` is the roadmap and decision log.

- iOS: main pushes ship via EAS — a TestFlight build when the native fingerprint changed, otherwise an OTA update to the `main` branch; every PR gets an OTA preview channel `pr-<n>` (commented on the PR) loadable via Settings → PR preview on-device — see `docs/distribution.md`
