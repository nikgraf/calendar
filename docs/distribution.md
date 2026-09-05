# Desktop distribution: macOS testing builds

Every push to `main` runs the `testing-build` job in `.github/workflows/ci.yml`
(on `macos-26` — the Swift model helper needs the macOS 26 SDK; the packaged
app still runs on older macOS with the model reporting unavailable),
producing a **signed + notarized, Apple Silicon (arm64)** zip of the desktop app
as a GitHub Actions artifact. Retention is 14 days — a fresh build lands on
every merge, so testers should always grab a recent one.

Decisions behind this setup: arm64-only (no universal build — Intel Macs are
out of the target group; since the sqlite driver moved to `node:sqlite`
there is no native-module obstacle either way, so this is purely a
target-audience call); artifact-only distribution (no GitHub releases, no
auto-update — the repo is private, so `update-electron-app` stays a
harmless no-op).

## Identifying a build

`CFBundleVersion` is stamped with the short commit SHA (`BUILD_VERSION` →
`packagerConfig.buildVersion` in `apps/desktop/forge.config.cjs`). Check it via
Finder's Get Info on Solunivo.app, or:

```
defaults read /Applications/Solunivo.app/Contents/Info.plist CFBundleVersion
```

## One-time secret setup (repo admin)

The job fails loudly (a dedicated `::error` preflight step — Forge would
otherwise silently degrade to an unsigned build) until all six secrets
exist under
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

## Known limitation: no OAuth config in the artifact

The desktop OAuth client id/secret come from env vars or the gitignored
`google-oauth.local.json` — neither is baked into CI builds, so a
downloaded testing build cannot complete Google sign-in yet. Testers can
inspect the UI; full use requires a local dev setup (or a future decision
to embed the non-confidential RFC 8252 desktop client config in the
build).

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
which is **fingerprint-gated**: the `decide` job computes the commit's native
fingerprint (`npx expo-updates fingerprint:generate`) and compares it against
the `runtime.version` of the latest finished main-channel build
(`eas build:list`). With `runtimeVersion.policy: fingerprint` those are the
same hash, so equality means an OTA update reaches every install of the
latest build.

- **Unchanged** (JS/TS/docs-only merges — most of them): publishes
  `eas update --branch main` in ~30s; installed TestFlight builds load it
  on next launch. No cloud build, no build number.
- **Changed** (native deps, config plugins, SDK bumps): a full EAS build
  and TestFlight submit, as before.
- **Fail toward building**: if the fingerprint or the build lookup errors,
  the workflow builds and emits a warning — a wasted build is visible and
  cheap; a wrongly skipped one strands testers on a stale binary silently.
- `workflow_dispatch` always builds — the manual rebuild escape hatch.
- ios.yml runs its own `verify` job (same lint/typecheck/test gate as
  ci.yml) rather than depending across workflows — GitHub can't `needs:`
  a job in another workflow file; the duplication is the price of keeping
  iOS publishing self-contained.

Two comparison caveats, both fail-safe. The baseline is the latest
_finished_ build, not "what testers run": installs still on an older
fingerprint silently stop receiving updates until they install the newer
build (and a finished build whose TestFlight submission failed already
failed CI loudly, so it can't go unnoticed). And `testflight`-label builds
from PR branches also land on channel `main`, so an unmerged native PR's
label build shifts the baseline — JS-only merges then full-build until
that PR merges, after which its merge ships as an OTA on top of the label
build instead of rebuilding.

Every PR push publishes an **OTA preview update** to channel `pr-<number>`
in ~30s and comments the channel name on the PR.

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

## One-time setup (done — kept for re-setup)

All of this is complete: the EAS project id is in `app.json`, the ASC app
id (`6803542567`) is in `eas.json`, `EXPO_TOKEN` is set, and the first
TestFlight build has shipped. If credentials ever need recreating:

1. Expo account: `pnpm exec eas login` in `apps/ios`, then `eas init` (writes
   the project id into app.json) and `eas update:configure` (fills
   `updates.url`).
2. App Store Connect: run the first `eas build --profile testflight`
   interactively — EAS creates + stores the distribution cert and an ASC API
   key; `eas submit` can create the ASC app for `com.solunivo.app`. Put the
   ASC app id into `eas.json` → `submit.testflight`.
3. Repo secret **`EXPO_TOKEN`** (expo.dev → Account settings → Access
   tokens). Until it exists, a `preflight` job emits a `::warning` and
   **every publishing job skips quietly** — deliberate, so agent PRs
   aren't blocked before setup, but it means a missing/expired token
   shows up as skipped jobs, not red ones.
4. Google OAuth: the iOS client must match bundle id `com.solunivo.app`
   (see README) — sign-in in TestFlight builds needs it.
5. TestFlight internal testing: add yourself (and teammates) as internal
   testers in App Store Connect — internal builds need no Apple review.

## Costs / quotas

- EAS free tier: ~30 cloud builds/month; OTA updates are effectively free at
  this scale. The fingerprint gate means main merges only consume builds on
  native changes; JS-only merges and the per-PR path cost no builds at all.
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
crash on the settings screen. The local Expo module for Apple Reminders
(`apps/ios/modules/solunivo-reminders`) is another: an older client reports
Reminders as "unavailable" in Diagnostics until rebuilt.

Updates are disabled in dev builds, so **Settings → PR preview** shows
"Updates are disabled in this build" instead of channel controls. That is the
quickest way to confirm a rebuild picked up `expo-updates`.

Maestro e2e (`pnpm test:e2e:ios`) runs against this dev client, so install a
fresh one before those flows after a native change.

The same profile has a second consumer: CI's `ios-e2e` job fetches the
`development-simulator` build whose fingerprint matches the commit
(`eas build:list --fingerprint-hash`, then the archive URL) and keeps the
extracted `.app` in the Actions cache keyed on that fingerprint. Only a
commit with a **new** native fingerprint and no finished build for it
makes CI request one (`eas build --profile development-simulator`), so
the quota cost is one simulator build per native change — the same
economics as the TestFlight gate. Running `eas build --profile
development-simulator` locally after a native change means CI finds it
ready.

### Local Xcode build (fallback)

```sh
pnpm --filter @calendar/ios prebuild   # regenerate ios/ + install pods
pnpm --filter @calendar/ios ios        # expo run:ios — compiles locally, boots the simulator
```

Useful for debugging native code or working offline. First compile takes
~10-20 minutes. `apps/ios/ios/` is generated and gitignored — if it gets into
a weird state, rerun prebuild with `--clean`.
