# Desktop distribution: macOS testing builds

Every push to `main` runs the `testing-build` job in `.github/workflows/ci.yml`,
producing a **signed + notarized, Apple Silicon (arm64)** zip of the desktop app
as a GitHub Actions artifact. Retention is 14 days — a fresh build lands on
every merge, so testers should always grab a recent one.

Decisions behind this setup: arm64-only (no universal build — Intel Macs are
out of the target group, and universal would need a dual-arch `better-sqlite3`
rebuild + lipo); artifact-only distribution (no GitHub releases, no auto-update
— the repo is private, so `update-electron-app` stays a harmless no-op).

## Identifying a build

`CFBundleVersion` is stamped with the short commit SHA (`BUILD_VERSION` →
`packagerConfig.buildVersion` in `apps/desktop/forge.config.cjs`). Check it via
Finder's Get Info on Solunivo.app, or:

```
defaults read /Applications/Solunivo.app/Contents/Info.plist CFBundleVersion
```

## One-time secret setup (repo admin)

The job fails loudly until all six secrets exist under
**GitHub → repo Settings → Secrets and variables → Actions**:

| Secret                       | Value                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `MACOS_CERTIFICATE_P12`      | Base64 of the "Developer ID Application" cert + private key: export both from Keychain Access as a `.p12`, then `base64 -i cert.p12 \| pbcopy` |
| `MACOS_CERTIFICATE_PASSWORD` | The password chosen during the `.p12` export                                                                                                   |
| `APPLE_SIGNING_IDENTITY`     | The cert's full common name, e.g. `Developer ID Application: Nik Graf (TEAMID)` (`security find-identity -v -p codesigning` shows it)          |
| `APPLE_ID`                   | Apple Developer account email                                                                                                                  |
| `APPLE_PASSWORD`             | An **app-specific password** created at appleid.apple.com (not the account password)                                                           |
| `APPLE_TEAM_ID`              | 10-character team id from the Apple Developer membership page                                                                                  |

Requires a paid Apple Developer membership; create the Developer ID Application
certificate at developer.apple.com → Certificates if none exists yet.

The same four `APPLE_*` variables activate signing/notarization for local
`pnpm --filter @calendar/desktop make` runs — the forge config is env-gated.

## Installing a testing build (testers)

1. Open the repo's **Actions** tab → latest green `CI` run on `main` (requires
   repo read access).
2. Download the `Solunivo-testing-<sha>` artifact.
3. Unzip twice (the artifact download wraps the maker zip), then drag
   `Solunivo.app` to `/Applications`. It's notarized and stapled — no
   Gatekeeper hoops, first launch just works.

## Manual rebuild

Actions → CI → **Run workflow** (`workflow_dispatch`) rebuilds from any branch,
useful after adding/rotating secrets.

## CI details worth knowing

- The job `needs: gate` (lint/typecheck/unit) but not `e2e` — merge protection
  already required e2e on the PR; a flaky e2e rerun shouldn't block builds.
- The in-CI verification step runs `codesign --verify --deep --strict`,
  `spctl --assess --type execute` (expects "Notarized Developer ID"), and
  `xcrun stapler validate` before uploading.
- The Developer ID cert lives only in a temporary keychain created from the
  secret for the duration of the job and is deleted in an `always()` step.
- Notarization adds ~2–10 minutes; the job timeout is 30.
- Builds currently ship the stock Electron icon (see the app-icons todo).
