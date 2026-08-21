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

# iOS: TestFlight + per-PR previews

Every push to `main` triggers the `iOS` workflow (`.github/workflows/ios.yml`),
which kicks off an **EAS Build** (Expo's cloud — handles signing) and
auto-submits to **TestFlight** (`--no-wait`: CI returns immediately; build +
submission status live in the EAS dashboard / email). Every PR push publishes
an **OTA preview update** to channel `pr-<number>` in ~30s and comments the
channel name on the PR.

## Platform constraint: one install per bundle id

iOS allows one installed copy of `com.solunivo.app`. You can't have several
PR builds side by side. Instead:

- **JS/TS changes (almost all agent PRs)** — keep the installed TestFlight
  build and switch channels in-app: **Settings → PR preview** → enter
  `pr-<number>` (from the PR comment) → Load. "Back to main" returns to the
  main channel. If no update loads immediately, force-quit and reopen.
- **Native changes** (new native deps, config plugins, Expo SDK bumps) change
  the update **fingerprint** (`runtimeVersion.policy: fingerprint`), so OTA
  previews from such PRs are invisible to the installed build — deliberately,
  they'd crash it. Add the **`testflight` label** to the PR: CI ships a real
  TestFlight build; install it (replaces the current one), then load the PR
  channel in-app.
- TestFlight itself also lets you switch between any processed builds
  (TestFlight app → Previous Builds).

## One-time setup (Nik)

1. Expo account: `pnpm exec eas login` in `apps/ios`, then `eas init` (writes
   the project id into app.json) and `eas update:configure` (replaces
   `EAS_PROJECT_ID_PLACEHOLDER` in `updates.url`).
2. App Store Connect: run the first `eas build --profile testflight`
   interactively — EAS creates + stores the distribution cert and an ASC API
   key; `eas submit` can create the ASC app for `com.solunivo.app`. Put the
   ASC app id into `eas.json` → `submit.testflight` (replaces
   `ASC_APP_ID_PLACEHOLDER`).
3. Repo secret **`EXPO_TOKEN`** (expo.dev → Account settings → Access
   tokens). Until it exists, the main/label jobs fail loudly and the PR
   preview job skips quietly.
4. Google OAuth: the iOS client must match bundle id `com.solunivo.app`
   (see README) — sign-in in TestFlight builds needs it.
5. TestFlight internal testing: add yourself (and teammates) as internal
   testers in App Store Connect — internal builds need no Apple review.

## Costs / quotas

- EAS free tier: ~30 cloud builds/month; OTA updates are effectively free at
  this scale. Main merges + occasional `testflight` labels fit comfortably;
  the per-PR path costs no builds at all.
- The CI jobs run on ubuntu (cheap); the actual iOS builds run on EAS.

## Simulator dev client (EAS build — preferred)

Build in the cloud, download, install:

```sh
cd apps/ios
pnpm exec eas build --platform ios --profile development-simulator
pnpm exec eas build:run --platform ios --latest   # downloads + installs on a booted simulator
pnpm --filter @calendar/ios start                 # Metro, then open the app
```

No Xcode toolchain, no signing (simulator builds are unsigned), and the
artifact is a URL anyone on the team — or an agent — can install from. Costs
one build from the EAS quota. `build:run` picks a booted simulator; the
downloaded `.tar.gz` also works by extracting and dragging the `.app` in.

**Rebuild the dev client only when native code changes** (a new native module,
config plugin, or Expo SDK bump). JS-only changes reload over Metro. Adding
`expo-updates` was exactly such a case — a dev client built before it would
crash on the settings screen.

Updates are disabled in dev builds, so **Settings → PR preview** shows
"Updates are disabled in this build" instead of channel controls. That is the
quickest way to confirm a rebuild picked up `expo-updates`.

Maestro e2e (`pnpm test:e2e:ios`) runs against this dev client, so install a
fresh one before those flows after a native change.

### Local Xcode build (fallback)

```sh
pnpm --filter @calendar/ios prebuild   # regenerate ios/ + install pods
pnpm --filter @calendar/ios ios        # expo run:ios — compiles locally, boots the simulator
```

Useful for debugging native code or working offline. First compile takes
~10-20 minutes. `apps/ios/ios/` is generated and gitignored — if it gets into
a weird state, rerun prebuild with `--clean`.
