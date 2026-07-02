# Calendar

A Fantastical-style Google Calendar client: iOS app (Expo SDK 57, React Native) and macOS desktop app (Electron 43, React DOM), sharing a TypeScript core. Client-only — no backend; the apps talk directly to the Google Calendar REST API and sync via incremental sync tokens + polling.

## Architecture

Effect v4 (beta, all `effect*` packages pinned to one version) is the foundation for all non-UI code:

- `packages/core` — Schema domain models, tagged errors, Temporal time helpers (`@js-temporal/polyfill`), rrule-temporal recurrence expansion, pure layout engine, the `AppBackend` rpc group (the platform seam).
- `packages/google` — TokenStore/TokenManager services, GoogleCalendarClient over `effect/unstable/http`, Schedule-based retry.
- `packages/db` — `@effect/sql` migrations + repository services with Schema row codecs; Reactivity keys (`accounts`, `calendars`, `events:<calendarId>`) for invalidation.
- `packages/sync` — SyncEngine service: per-account sync fibers, pending-op queue, typed sync errors.
- `packages/app-state` — `@effect/atom-react` atoms shared by both UIs.
- `apps/desktop` — Electron: backend Layer stack in main, effect rpc over a preload MessagePort bridge to the renderer (React DOM + Tailwind v4 + React Compiler). Forge for packaging, tsdown builds main/preload, vite-plus (`vp`) serves the renderer.
- `apps/ios` — Expo dev client; in-process runtime (no rpc hop), `@effect/sql-sqlite-react-native` (op-sqlite), RN renderers on the shared layout engine.

Rules of thumb: I/O, orchestration, and validation are Effect (services + Layers, no thrown exceptions in shared code); pure math (layout, recurrence) and React components are plain TS. Shared packages ship raw TS source via `exports: ./src/index.ts` — no build step.

## Commands

- `pnpm check` / `pnpm fix` — lint + format (Oxlint/Oxfmt via vite-plus)
- `pnpm test` — vitest (via vite-plus); Effect code uses `@effect/vitest` with TestClock
- `pnpm typecheck` — `tsc --noEmit` in every workspace package
- `pnpm dev:desktop` — renderer dev server + tsdown watch + Electron
- `pnpm ios` — Expo run on iOS simulator

The full product plan lives in the repo owner's plan file; milestone tracking in session tasks.
