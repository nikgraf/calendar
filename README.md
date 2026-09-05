# Solunivo

A Fantastical-style Google Calendar client: iOS (Expo) + macOS (Electron), client-only, built on Effect v4. See `AGENTS.md` for architecture.

- Day/week/month views with 1:1 drag gestures, recurring-event editing (this/following/all), per-calendar colors, offline-tolerant pending-op queue.
- Google Tasks and Apple Reminders side by side in the all-day task lane: create/edit/complete/delete, two-way sync, and a form that fits each — Reminders add due time, priority, alerts, repeat, URL, and moving between lists.
- On-device AI (Apple Foundation Models, no cloud): quick-add natural language parsing, "find a time" slot suggestions, and dictation — ⌘K bar on macOS, quick-add bar on iOS.

**Docs:** `docs/architecture.md` (data flow, op queue, recurring model, AI layer),
`docs/effect-v4-notes.md` (Effect v4 pre-release gotchas),
`docs/google-sync-and-testing.md` (verified API semantics, testing),
`docs/distribution.md` (CI builds, TestFlight, EAS updates).

**Privacy note:** the desktop window is hidden from screen shares and
recordings by default — see the Privacy section in Settings (Hidden /
Visible for 10 min / Always visible).

## Setup

Prerequisites: Node ≥ 24, pnpm ≥ 11 (`corepack enable`).

```sh
pnpm install
```

SQLite is Node's built-in `node:sqlite` on desktop and op-sqlite on iOS —
there is no native-module rebuild step.

Optional, for the desktop AI features (quick-add parsing, find-a-time,
dictation): build the Swift model helper once (requires Xcode with the
macOS 26 SDK; Apple Silicon with Apple Intelligence enabled at runtime):

```sh
pnpm --filter @calendar/desktop build:helper
```

Without it the app runs fine — AI affordances show an "unavailable" notice.
The same helper hosts the Apple Reminders bridge (EventKit); Settings →
Apple Reminders asks for access and connects the device's lists.

### Google OAuth (required for sign-in)

Create a Google Cloud project once, then:

1. **APIs & Services → Library**: enable the _Google Calendar API_ and the _Google Tasks API_.
2. **APIs & Services → OAuth consent screen**: External, Testing mode; add yourself (and any other test users). Scopes: see `packages/google/src/oauth/scopes.ts` — the single source of truth (`calendar.readonly`, `calendar.events`, `tasks`, plus `openid email profile`).
3. **Credentials → Create credentials → OAuth client ID**:
   - Type **Desktop app** → used by the macOS app. Note client ID + secret.
   - Type **iOS** (bundle id `com.solunivo.app`) → used by the iOS app. Note client ID.
4. Configure the desktop app, either via env vars:
   ```sh
   export GOOGLE_DESKTOP_CLIENT_ID="....apps.googleusercontent.com"
   export GOOGLE_DESKTOP_CLIENT_SECRET="..."
   ```
   or by creating `apps/desktop/google-oauth.local.json` (gitignored):
   ```json
   { "clientId": "....apps.googleusercontent.com", "clientSecret": "..." }
   ```

The desktop client secret is not confidential (RFC 8252) but stays out of git anyway.

For iOS, set the client id in `apps/ios/app.json` under `expo.extra.googleIosClientId`
and add the reversed client id (`com.googleusercontent.apps.<id>`) to `expo.scheme`,
then re-run `pnpm --filter @calendar/ios prebuild`.

## Development

```sh
# Desktop: renderer dev server + app (two terminals)
pnpm --filter @calendar/desktop dev
pnpm --filter @calendar/desktop dev:app

# iOS simulator dev client: build on EAS, install, then run Metro
# (cd apps/ios && pnpm exec eas build -p ios --profile development-simulator)
# (cd apps/ios && pnpm exec eas build:run -p ios --latest)
pnpm --filter @calendar/ios start

# Quality gates
pnpm test && pnpm check && pnpm typecheck

# Desktop e2e (build first)
pnpm --filter @calendar/desktop build && pnpm test:e2e
```
