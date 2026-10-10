# Desktop distribution: macOS testing builds

Every push to `main` runs the `testing-build` job in `.github/workflows/ci.yml`
(on `macos-26` — the Swift helper needs the macOS 26 SDK; the packaged app
still runs on older macOS with the model reporting unavailable), producing
a **signed + notarized, Apple Silicon (arm64)** zip of the desktop app as a
GitHub Actions artifact, kept 14 days. Decisions: arm64 only (Intel Macs
are out of the target group), artifact-only distribution — no GitHub
releases and no auto-update while the repo is private
(`update-electron-app` is wired but update.electronjs.org only serves
public repos, so it stays a no-op).

## Identifying a build

`CFBundleVersion` is the short commit SHA (`BUILD_VERSION` →
`packagerConfig.buildVersion` in `apps/desktop/forge.config.cjs`):

```
defaults read /Applications/Solunivo.app/Contents/Info.plist CFBundleVersion
```

## One-time secret setup (repo admin)

The job fails loudly (a dedicated `::error` preflight step — Forge would
otherwise silently degrade to an unsigned build) until all six secrets
exist under **GitHub → repo Settings → Secrets and variables → Actions**:

| Secret                       | Value                                                                                                                                          |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `MACOS_CERTIFICATE_P12`      | Base64 of the "Developer ID Application" cert + private key: export both from Keychain Access as a `.p12`, then `base64 -i cert.p12 \| pbcopy` |
| `MACOS_CERTIFICATE_PASSWORD` | The password chosen during the `.p12` export                                                                                                   |
| `APPLE_SIGNING_IDENTITY`     | The cert's full common name, e.g. `Developer ID Application: Nik Graf (TEAMID)` (`security find-identity -v -p codesigning` shows it)          |
| `APPLE_ID`                   | Apple Developer account email                                                                                                                  |
| `APPLE_PASSWORD`             | An **app-specific password** created at appleid.apple.com (not the account password)                                                           |
| `APPLE_TEAM_ID`              | 10-character team id from the Apple Developer membership page                                                                                  |

Requires a paid Apple Developer membership; create the Developer ID Application
certificate at developer.apple.com → Certificates if none exists yet. The
same `APPLE_*` variables activate signing/notarization for local
`pnpm --filter @calendar/desktop make` runs — the forge config is env-gated.

## OAuth config in the artifact

Developers supply the desktop OAuth client through env vars or the
gitignored `google-oauth.local.json` (see README). For the testing build,
CI writes `apps/desktop/google-oauth.json` from the
`GOOGLE_DESKTOP_CLIENT_ID` and `GOOGLE_DESKTOP_CLIENT_SECRET` repository
secrets before `make` (`loadOAuthConfig` reads it as its last source, and
Forge ships it inside the package). Without them the job warns and the
download can only show the UI. The desktop client secret is not
confidential (RFC 8252 — it is a public client), which is why embedding it
is fine.

## Versions

The apps are `0.1.0` (root, `apps/desktop`, `apps/ios` and its local
modules; the iOS `expo.version` is its CFBundleShortVersionString); the
testing build's CFBundleVersion is the short commit SHA, and iOS build
numbers come from EAS (`appVersionSource: remote`, auto-increment). Bump the
versions together when a release is worth a number — the iOS one is part
of the native fingerprint, so its bump needs a new build. `CHANGELOG.md`
collects what changed between bumps; the decision log in
`docs/decisions.md` has the detail.

## Installing a testing build (testers)

1. Open the repo's **Actions** tab → latest green `CI` run on `main` (requires
   repo read access).
2. Download the `Solunivo-testing-<sha>.zip` artifact.
3. Unzip once to get `Solunivo.app`, then drag it to `/Applications`. It's
   notarized and stapled — no Gatekeeper hoops, first launch just works.

A database from before the schema baseline refuses to open ("Database is
ahead of this build"): delete and reinstall the app once, or run
`pnpm reset:local` on a developer Mac.

## Manual rebuild

Actions → CI → **Run workflow** (`workflow_dispatch`) rebuilds from any branch,
useful after adding/rotating secrets.

## CI details worth knowing

- The job `needs: gate` (lint/typecheck/unit) but not `e2e` — merge protection
  already required e2e on the PR; a flaky e2e rerun shouldn't block builds.
- The in-CI verification step runs `codesign --verify --deep --strict`,
  `spctl --assess --type execute` (expects "Notarized Developer ID"),
  `xcrun stapler validate` and `solunivo-cli --version` against the app
  extracted from the exact ZIP to be uploaded, and checks that the app and
  helper remain executable.
- The same step checks the app and Swift helper signatures for the Address Book
  and Calendars entitlements (`apps/desktop/scripts/check-privacy-entitlements.sh`).
  Hardened runtime needs these for Contacts and EventKit permission prompts,
  even without App Sandbox; usage descriptions in Info.plist alone are
  insufficient.
- The Developer ID cert lives only in a temporary keychain created from the
  secret for the duration of the job and is deleted in an `always()` step.
- Notarization adds ~2–10 minutes; the job timeout is 30.
- Builds ship the Solunivo icon from `apps/desktop/assets/icon.icns`, generated
  from `brand/` by `pnpm brand:build` (see `brand/README.md`).

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
- **Changed** (native deps, config plugins, SDK bumps, the app icon,
  `ios.infoPlist`, `apps/ios/package.json` scripts): a full EAS build and
  TestFlight submit. An icon change can never ship as an OTA update, and a
  PR preview channel does not show it either.
- **Fail toward building**: if the fingerprint or the build lookup errors,
  the workflow builds and emits a warning — a wasted build is visible and
  cheap; a wrongly skipped one strands testers on a stale binary silently.
- `workflow_dispatch` always builds — the manual rebuild escape hatch.
- ios.yml runs the same gate as ci.yml through the reusable
  `.github/workflows/gate.yml` (`workflow_call`) — GitHub can't `needs:` a
  job in another workflow file, so each workflow calls it; the check
  reports as "Gate / Lint, typecheck, unit tests".

The native bridges (`packages/*/swift`) reach the app through symlinks in
`modules/*/ios`, which the fingerprint hashes without following, so
`apps/ios/fingerprint.config.cjs` adds those directories as extra sources
— without it a Swift-only change shipped the previous binary.

`expo-notifications`' config plugin adds the `aps-environment` (push)
entitlement, which the App Store profile does not carry. Notifications are
local only, so `apps/ios/plugins/withLocalNotificationsOnly.cjs` (listed
last in `app.json` plugins) removes the entitlement again; the resolved
entitlements are visible with `expo config --type introspect`.

`apps/ios/app.json` declares `NSLocationWhenInUseUsageDescription`
although nothing in the app asks for location: App Store Connect's static
scan sees `CLLocationManager` referenced by expo-maps and the CoreLocation
links of the geo and apple-calendar pods, and warns (ITMS-90683) without
it — do not delete the key as unused, the warning returns on the next
upload. Its wording must not claim "nothing leaves your device": place
search is `MKLocalSearch`, a call to Apple's servers. It is declared
directly rather than through expo-maps' `requestLocationPermission`
option, which would also claim Android location permissions. `ios.infoPlist`
feeds the fingerprint, so a change there forces a TestFlight build.

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

## Two variants: production and dev

The app exists twice, and the two install side by side on one device:

|               | Production                       | Dev                                                     |
| ------------- | -------------------------------- | ------------------------------------------------------- |
| Bundle id     | `com.solunivo.app`               | `com.solunivo.app.dev`                                  |
| Name, icon    | Solunivo, the light icon         | Solunivo Dev, the dark icon                             |
| EAS profiles  | `testflight`                     | `development`, `development-simulator`, `e2e-simulator` |
| Distribution  | TestFlight, later the App Store  | internal (ad hoc) and the simulator CI drives           |
| URL schemes   | `solunivo`, its Google redirect  | `solunivo-dev`, its Google redirect                     |
| Google client | `app.json` → `googleIosClientId` | `DEV_GOOGLE_IOS_CLIENT_ID` in `app.config.js`           |
| Meant for     | the real accounts                | test accounts, Metro, Maestro                           |

`apps/ios/app.json` is the production app as written;
`apps/ios/app.config.js` layers the dev variant on top when
`APP_VARIANT=development`. **Unset means production**, so a release job
that forgets the variable can never ship the dev identity — `ios.yml` sets
nothing. The dev side sets it everywhere it is needed: the two development
profiles and `e2e-simulator` in `eas.json`, the `start` / `ios` / `prebuild`
scripts, the `ios-e2e` and `live-ios` jobs, and `check-devclient.mjs`.
Keep `app.config.js` plain CommonJS: Expo evaluates it on every manifest
request and transpiles a `.ts` config with Babel each time, which pushed
the dev client's first request past its 10 s budget on CI.

What that buys and what it does not:

- iOS keys the database, the Keychain (OAuth tokens), permissions and
  notification settings on the bundle id, so the two apps share nothing of
  that. Sign the dev app in to test accounts and leave the real ones to
  production.
- **Apple data is the device's, not the app's.** Both apps see the same
  Calendar, Reminders and Contacts once granted. To keep the dev app off
  real Apple data, do not grant it those permissions — and leave its
  notifications off, or birthdays and Apple events remind twice.
- The variants have **different native fingerprints** (name, bundle id,
  schemes, icon and `extra` are all hashed). A fingerprint only matches a
  build when it is computed under that build's `APP_VARIANT`; `eas update`
  for TestFlight runs without it and is therefore production's.
- Two installed apps must not claim the same URL scheme — iOS picks one
  arbitrarily, and a Google sign-in could return to the wrong app. Hence
  the separate scheme and the separate OAuth client (an iOS client is
  bound to one bundle id, and its redirect is its reversed client id).
  Production also drops expo-dev-client's generated `exp+solunivo` scheme,
  which only a dev launcher can answer.
- The dev client is a debug build that loads from Metro. Away from the Mac
  it opens to the dev launcher, so it is a development tool, not a second
  everyday app. A separate "beta" app in App Store Connect is deliberately
  not part of this.

### One install per variant

Within a variant the platform rule still holds: iOS allows one installed
copy of `com.solunivo.app`. You can't have several PR builds side by side.
Instead:

- **JS/TS changes (almost all agent PRs)** — keep the installed TestFlight
  build and switch channels in-app: **Settings › Advanced › PR Preview** → enter
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

The EAS project id is in `app.json`, the ASC app id (`6803542567`) is in
`eas.json`, `EXPO_TOKEN` is set, and TestFlight builds ship. If
credentials ever need recreating:

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
4. Google OAuth: one iOS client per variant, each matching its bundle id
   (`com.solunivo.app`, `com.solunivo.app.dev`; see README) — sign-in
   needs the one that belongs to the installed app.
5. TestFlight internal testing: add yourself (and teammates) as internal
   testers in App Store Connect — internal builds need no Apple review.

## Costs / quotas

EAS free tier: ~30 cloud builds/month; OTA updates are effectively free at
this scale. The fingerprint gate means main merges only consume builds on
native changes; JS-only merges and the per-PR path cost no builds at all.
The CI jobs run on ubuntu; the actual iOS builds run on EAS.

## Simulator dev client (EAS build — preferred)

Build in the cloud, download, install:

```sh
cd apps/ios
pnpm exec eas build --platform ios --profile development-simulator
pnpm exec eas build:run --platform ios --latest   # downloads + installs on a booted simulator
pnpm --filter @calendar/ios start                 # Metro, then open the app
```

This is the dev variant (`com.solunivo.app.dev`, "Solunivo Dev"): the
profile sets `APP_VARIANT=development`, and so does the `start` script —
Metro has to serve the dev variant's config (its Google client id) to the
dev client. No Xcode toolchain, no signing (simulator builds are
unsigned), and the artifact is a URL anyone on the team — or an agent —
can install from. Costs one build from the EAS quota. `build:run` picks a
booted simulator; the downloaded `.tar.gz` also works by extracting and
dragging the `.app` in.

**Rebuild the dev client only when native code changes** (a new native
module, config plugin, Swift bridge change, or Expo SDK bump). JS-only
changes reload over Metro. `apps/ios/scripts/check-devclient.mjs` (run by
`pnpm test:e2e:ios`) warns when the installed client's fingerprint differs
from the working tree's. Updates are disabled in dev builds, so
**Settings › Advanced › PR Preview** shows "Updates are disabled in this
build" instead of channel controls.

Maestro e2e (`pnpm test:e2e:ios`) runs against this dev client, so install a
fresh one before those flows after a native change.

The same profile has a second consumer: the nightly `live-ios` job
(`google-live.yml`) fetches the `development-simulator` build whose
fingerprint matches the commit (`eas build:list --fingerprint-hash`, then
the archive URL) and keeps the extracted `.app` in the Actions cache keyed
on that fingerprint.

CI's `ios-e2e` job does the same with a third profile, `e2e-simulator`:
the dev variant (same bundle id, so not a third variant) built in Release
configuration for the simulator, without the dev client. The job embeds
each commit's JS into that build (`apps/ios/e2e/ci/repack-app.sh`) and
runs it with no Metro — see docs/google-sync-and-testing.md. Only a commit
with a **new** native fingerprint and no finished build for it makes a job
request one, so the quota cost is one simulator build per native change
and profile — the same economics as the TestFlight gate. Running `eas
build --profile e2e-simulator` locally after a native change means CI
finds it ready. The jobs compute the fingerprint under
`APP_VARIANT=development` (job-level env); without it they would look up
production's hash and never find a build.

## Device dev client (next to the TestFlight app)

The same variant on a phone, installed beside the production app:

```sh
cd apps/ios
pnpm exec eas device:create                              # once per device: registers its UDID
pnpm exec eas build --platform ios --profile development # interactive the first time
```

Internal distribution is ad hoc: the device has to be in the provisioning
profile, and the first build for `com.solunivo.app.dev` needs an
interactive Apple login so EAS can create the App ID and the profile.
The same goes for the share extension (`com.solunivo.app.share` /
`com.solunivo.app.dev.share`, declared by `plugins/withShareExtension.cjs`
through `extra.eas.build.experimental.ios.appExtensions`) and the app
groups both targets share (`group.com.solunivo.app` /
`group.com.solunivo.app.dev`): the first build after adding them — one
`--profile testflight` and one `--profile development`, run
interactively from the branch — creates the extension App IDs, adds the
App Groups capability to the main ones and regenerates the profiles.
`ios.yml` runs the TestFlight build non-interactively on a fingerprint
change, so this has to happen before that merge lands.
Install from the build page's link or QR code. It needs no App Store
Connect record. With Metro running on the same network
(`pnpm --filter @calendar/ios start`), the dev launcher lists the server.

### Local Xcode build (fallback)

```sh
pnpm --filter @calendar/ios prebuild   # regenerate ios/ + install pods
pnpm --filter @calendar/ios ios        # expo run:ios — compiles locally, boots the simulator
```

Useful for debugging native code or working offline. First compile takes
~10-20 minutes. `apps/ios/ios/` is generated and gitignored — if it gets into
a weird state, rerun prebuild with `--clean`.
