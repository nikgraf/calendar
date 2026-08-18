# Solunivo

A Fantastical-style Google Calendar client: iOS (Expo) + macOS (Electron), client-only, built on Effect v4. See `AGENTS.md` for architecture.

**Docs:** `docs/architecture.md` (data flow, op queue, recurring model),
`docs/effect-v4-notes.md` (Effect v4 beta gotchas),
`docs/google-sync-and-testing.md` (verified API semantics, testing).

**Privacy note:** the desktop window is hidden from screen shares and
recordings by default — see the Privacy section in Settings (Hidden /
Visible for 10 min / Always visible).

## Setup

```sh
pnpm install
# native modules must match Electron's ABI (rerun after Electron upgrades):
pnpm --filter @calendar/desktop rebuild:native
```

### Google OAuth (required for sign-in)

Create a Google Cloud project once, then:

1. **APIs & Services → Library**: enable the _Google Calendar API_.
2. **APIs & Services → OAuth consent screen**: External, Testing mode; add yourself (and any other test users). Scopes: `calendar.readonly`, `calendar.events`, plus `openid email profile`.
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

# iOS simulator (dev client)
pnpm --filter @calendar/ios ios

# Quality gates
pnpm test && pnpm check && pnpm typecheck

# Desktop e2e (build first)
pnpm --filter @calendar/desktop build && pnpm test:e2e
```
