# Solunivo

A calendar for Google Calendar, Google Tasks, Apple Calendar and Apple
Reminders: iOS (Expo) + macOS (Electron), client-only, built on Effect
v4. `AGENTS.md` has the architecture map, the commands
and the rules; the deep docs are listed at its end.

- Day/week/month views (plus 2 Days and an agenda on iOS) with 1:1 drag
  gestures, recurring-event editing (this/following/all), per-calendar
  colors, up to three time zones, an offline-tolerant pending-op queue
  and conflicts resolved with a choice.
- Google Tasks and Apple Reminders side by side in the task lane and the
  Tasks tab, with a form that fits each; tasks and events convert into
  one another and move between accounts and providers.
- Apple Calendar calendars next to Google ones; events move between any
  two calendars.
- Invitee autocomplete from the device address book and Google contacts;
  contact birthdays as chips with device-local reminders; event reminders
  delivered as local notifications on both platforms.
- On-device AI (Apple Foundation Models, no cloud): quick-add parsing,
  "find a time", dictation, and capture of events from a pasted email
  (⌘V on the Mac) or a shared screenshot (the iOS share sheet).
- Search across events and tasks (⌘F on the Mac, the Search tab on iOS);
  settings export/import and a watched settings file on the Mac.
- Experimental: calendar mirrors (share a reduced copy of your calendars)
  and an agent gateway (MCP/CLI access for other agents on the Mac).

**Brand:** [Brand assets and usage](brand/README.md) covers the logo, app icons,
Inter fonts, color tokens, and `pnpm brand:build` exports. **Privacy:**
[PRIVACY.md](PRIVACY.md); the desktop window is hidden from screen shares
and recordings by default (Settings → General; the toolbar's eye icon shows
it and makes the window visible for 10 minutes).

## Setup

Prerequisites: Node ≥ 24, pnpm ≥ 12 (`corepack enable`).

```sh
pnpm install
```

SQLite is Node's built-in `node:sqlite` on desktop and op-sqlite on iOS —
there is no native-module rebuild step.

Optional, for the desktop AI features and the Apple bridges (Reminders,
Calendar, Contacts, Maps): build the Swift helper once (requires Xcode
with the macOS 26 SDK; the AI needs Apple Silicon with Apple Intelligence
enabled at runtime):

```sh
pnpm --filter @calendar/desktop build:helper
```

Without it the app runs fine — the AI field says why the model is
unavailable, and the Apple connections in Settings → Accounts report the
bridge as unavailable.

### Google OAuth (required for sign-in)

Create a Google Cloud project once, then:

1. **APIs & Services → Library**: enable the _Google Calendar API_, the
   _Google Tasks API_ and the _People API_ (invitee suggestions; a
   project without it answers the contacts sync with 403
   `SERVICE_DISABLED`). Not the _Contacts API_ — that is the retired
   GData product; the People API replaced it.
2. **APIs & Services → OAuth consent screen**: External, Testing mode; add
   yourself (and any other test users). Scopes: see
   `packages/google/src/oauth/scopes.ts` — the single source of truth
   (`calendar.readonly`, `calendar.events`, `calendar.app.created`,
   `tasks`, `contacts.readonly`, `contacts.other.readonly`, plus
   `openid email profile`). The two `contacts.*` scopes are _sensitive_:
   fine in Testing mode, but moving the consent screen to Production
   requires Google's app verification for them.
3. **Credentials → Create credentials → OAuth client ID**:
   - Type **Desktop app** → used by the macOS app. Note client ID + secret.
   - Type **iOS** (bundle id `com.solunivo.app`) → used by the production iOS app (TestFlight). Note client ID.
   - Type **iOS** (bundle id `com.solunivo.app.dev`) → used by the iOS dev client, which is a separate app. Note client ID.
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
An account signed in before a scope was added re-consents by re-running
**Add Google Account** for the same address.

For iOS, the production client id goes into `apps/ios/app.json` under
`expo.extra.googleIosClientId`, with the reversed client id
(`com.googleusercontent.apps.<id>`) added to `expo.scheme`. The dev client's
goes into `DEV_GOOGLE_IOS_CLIENT_ID` in `apps/ios/app.config.js`, which derives
its scheme. Either change needs a new build of that variant (see
`docs/distribution.md`, "Two variants").

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

# iOS e2e (Maestro + a JDK, dev client + Metro running — see AGENTS.md)
pnpm test:e2e:ios
```

### Resetting local data

`pnpm reset:local` (with the desktop app and Metro stopped) wipes
everything the apps keep on this machine: the desktop database, tokens,
logs and settings for both the dev and the packaged build, the
safeStorage keys in the login keychain, Squirrel update caches, stray e2e
profiles, and the iOS app on every booted simulator (a physical device
is reset by deleting the app). It leaves Contacts/Reminders/Calendar
permissions, your Apple data, `~/.solunivo` and `google-oauth.local.json`
alone.
