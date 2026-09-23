# Solunivo

A Fantastical-style Google Calendar and Apple Calendar client: iOS app (Expo SDK 57, React Native) and macOS desktop app (Electron 44, React DOM), sharing a TypeScript core. Client-only — no backend; the apps talk directly to the Google Calendar and Google Tasks REST APIs and sync via incremental sync tokens (events) / updatedMin watermarks (tasks) + polling.

## Architecture

Effect v4 (rc pre-release, all `effect*` packages pinned to one version via the pnpm catalog) is the foundation for all non-UI code:

- `packages/core` — Schema domain models, tagged errors, Temporal time helpers (`@js-temporal/polyfill`), rrule-temporal recurrence expansion, pure layout engine, drag/time math, the `findSlots` free-time solver (`src/scheduling/`), and `AppBackendRpcs` — the effect rpc group that is the platform seam (request/response methods + a `stream: true` invalidations rpc).
- `packages/google` — TokenStore/TokenManager services, GoogleCalendarClient + GoogleTasksClient over `effect/unstable/http`, Schedule-based retry.
- `packages/db` — repository services with Schema row codecs over a hand-rolled migration runner (`src/migrate.ts` — effect's Migrator is Metro-incompatible); Reactivity keys (`accounts`, `calendars`, `events` + `events:<calendarId>`, `pendingOps`, `tasks`, `taskLists`, `notice:dropped`) for invalidation.
- `packages/sync` — SyncEngine service: per-account sync fibers, pending-op queue (10 op kinds incl. tasks and `move`), typed sync errors; Google Tasks watermark sync; Apple Reminders mirror (`syncReminders`) and provider-dispatched task mutations (`reminderMutations.ts`); Apple Calendar calendar mirror (`syncAppleCalendar`), read-through events (`AppleCalendarEvents`) and provider-dispatched event mutations + cross-provider moves (`appleEventMutations.ts`, `moveEvent` in `mutations.ts`).
- `packages/ai` — provider seam + prompt/normalize pipelines for quick-add parsing and find-a-time; platform adapters (Swift helper on desktop, @react-native-ai/apple on iOS) live in the apps.
- `packages/reminders` — Apple Reminders: `RemindersClient` service over one JSON protocol (`reminders.status/requestAccess/listLists/list/create/update/setCompleted/delete`), EventKit ↔ `TaskRecord` mapping, in-memory fake. Native side: `swift/RemindersBridge.swift`, symlinked into `apps/desktop/helper` and the local Expo module `apps/ios/modules/solunivo-reminders`.
- `packages/apple-calendar` — Apple Calendar (EventKit events): `AppleCalendarClient` service over one JSON protocol (`calendar.status/requestAccess/listCalendars/events/series/create/update/delete/move/setColor`), EventKit ↔ `EventRecord`/`CalendarInfo` mapping, in-memory fake with EventKit span semantics. Native side: `swift/AppleCalendarBridge.swift`, symlinked into `apps/desktop/helper` and the local Expo module `apps/ios/modules/solunivo-apple-calendar`.
- `packages/app-state` — shared atoms (`makeBackendAtoms`): reads subscribe to Reactivity keys (`accounts`/`calendars`/`events`), mutations are `runtime.fn` atoms invalidating those keys; backend-side invalidations arrive through the forwarding bridge (`packages/db/src/reactivityForward.ts` → IPC on desktop, in-process on iOS). React consumes them via `@effect/atom-react`.
- `apps/desktop` — Electron: backend Layer stack in main, served as an effect RpcServer over a preload frame channel (`duplexServerProtocol`/`duplexClientProtocol` in `packages/sync/src/rpcDuplex.ts`, ndjson serialization); the renderer holds an RpcClient that structurally satisfies `BackendClient`, and invalidation keys arrive as a typed rpc stream. Forge for packaging, tsdown builds main/preload, vite-plus (`vp`) serves the renderer.
- `apps/ios` — Expo dev client; in-process runtime (no rpc hop), `@effect/sql-sqlite-react-native` (op-sqlite), RN renderers on the shared layout engine.

Rules of thumb: I/O, orchestration, and validation are Effect (services + Layers, no thrown exceptions in shared code); pure math (layout, recurrence) and React components are plain TS. Shared packages ship raw TS source via `exports: ./src/index.ts` — no build step.

## Commands

- `pnpm check` / `pnpm fix` — lint + format (Oxlint/Oxfmt via vite-plus)
- `pnpm test` — vitest (via vite-plus); Effect code uses `@effect/vitest` with TestClock
- `pnpm test:e2e` — desktop e2e suite (`apps/desktop/e2e/`): launches the built Electron app with an isolated profile (`CALENDAR_USERDATA`) and drives it over CDP. `flows.e2e.ts` covers rendering, view switching, trackpad pan, editor CRUD, drag move/resize/cancel, drag to create a slot, recurring editing (override drag, scope selector, series split, occurrence delete), RSVP, visibility toggles, calendar color, month view, task lane + task editor, the pending-ops panel, the privacy modal and the ⌘K command bar (fake model provider); `reminders.e2e.ts` and `contacts.e2e.ts` run against seeded rows (`CALENDAR_REMINDERS=off`, `CALENDAR_CONTACTS=off`, `CALENDAR_APPLE_CALENDAR=off` and `CALENDAR_GEO=off` everywhere by default); `appleCalendar.e2e.ts` drives Apple events, the read-only viewer and moves in both directions over an in-memory EventKit (`CALENDAR_APPLE_CALENDAR=fixture`); `location.e2e.ts` drives the location picker and map over a geo fixture (`CALENDAR_GEO=fixture`); `birthdays.e2e.ts` adds a device-contacts fixture (`CALENDAR_CONTACTS=fixture`) for the chip, the detail view and the device-only reminder settings; `taskConvert.e2e.ts` moves tasks between Google and Reminders lists with Google writes left queued, and `taskConvertGoogle.e2e.ts` does it against the in-process fake Google API (`CALENDAR_GOOGLE=fixture`) so the pushes land; `conflicts.e2e.ts` seeds parked 412s (`SeedData.pendingOps`, `GoogleFixture.events`) and resolves them through the conflict banner against the same fake; `remindersReal.e2e.ts` and `appleCalendarReal.e2e.ts` are the CI-only real-EventKit siblings. Requires `pnpm --filter @calendar/desktop build` first
- `pnpm test:e2e:ios` — Maestro flows (`apps/ios/e2e/flows/`, 17 flows: dev-client bootstrap (CI only), launch, navigation, new-event sheet, accounts sheet, device permissions (CI only), day swipe, quick-add, create event, task lane, reminders form, real Reminders (CI only), invitees, all-day event chip, birthday reminder settings, location, Apple Calendar connect, task convert). CI starts Metro with `EXPO_PUBLIC_CALENDAR_GOOGLE=fixture` (fake Google API + signed-in fixture account); locally the Google halves are no-ops unless you do the same. Locally it excludes the two CI-only flows. Requires the Maestro CLI (`brew install mobile-dev-inc/tap/maestro`) plus a JDK on PATH (`brew install openjdk`, then `JAVA_HOME=$(brew --prefix openjdk)/libexec/openjdk.jdk/Contents/Home`), the app installed (`pnpm --filter @calendar/ios ios`), and Metro running (`pnpm --filter @calendar/ios start`)
- `pnpm typecheck` — `tsc --noEmit` in every workspace package
- `pnpm dev:desktop` — renderer dev server (pair with `pnpm --filter @calendar/desktop dev:app`)
- `pnpm ios` — Expo run on iOS simulator
- `pnpm --filter @calendar/desktop build:helper` — build the Swift model helper (needs the macOS 26 SDK; `make`/`package:app` run it automatically)
- `pnpm --filter @calendar/desktop package:app` — unsigned .app via Forge (signing/notarization activate via APPLE\_\* env vars); `pnpm --filter @calendar/desktop make` — zipped distributable
- `pnpm brand:build` — regenerate the app icons (ICNS, iOS PNG), `brand/tokens/tokens.css` and the brand kit under `output/branding/` from the SVG masters in `brand/` (macOS only: needs `iconutil`); `pnpm brand:check` verifies the committed exports are current and the 50 contrast pairs pass (CI runs it in the packaging smoke job)
- CI ships a signed+notarized arm64 testing zip on every main push (Actions artifact) — see `docs/distribution.md`

The full product plan lives in the repo owner's plan file; milestone tracking in session tasks.

## Deep docs

Start with `CLAUDE.md` (rules + map), then `docs/architecture.md`,
`docs/effect-v4-notes.md`, and `docs/google-sync-and-testing.md`.
`todo.md` is the ranked backlog; `docs/decisions.md` is the decision log
(shipped items and the decisions they settled).

- iOS: main pushes ship via EAS — a TestFlight build when the native fingerprint changed, otherwise an OTA update to the `main` branch; every PR gets an OTA preview channel `pr-<n>` (commented on the PR) loadable via Settings → PR preview on-device — see `docs/distribution.md`
