# Screenshots

A PR that changes UI shows it inside "What changes for the user", one
image per platform the change touches (iOS, Desktop):

- a before/after pair when an existing screen changes;
- a dark pair when colors change;
- iOS and Desktop side by side in a table, `<img width="300">` for iOS and
  `<img width="600">` for Desktop;
- files named `<platform>-<before|after>[-<what>][-dark].png`, e.g.
  `ios-after.png`, `desktop-before-dark.png`, `ios-after-swipe.gif`. The
  `PR complete` check finds a platform's images by the `ios-` / `desktop-`
  prefix.

A platform that can't be captured gets a line saying which and why ("No
iOS screenshot: the change is in the Mac's menu bar only."). Never leave
one out silently.

## Privacy

Fixture data only: the e2e harness's seeded profile on the Mac, the
fixture Google account and model on iOS. Never capture a profile signed
in to real accounts, the Mac's own Calendar, Reminders or Contacts, or a
`pnpm dev:desktop` run (it reads the Mac's real Apple data). Look at every
image before uploading it and drop any that shows a real person's name,
email, event or place: the repo may be public one day.

## Desktop

Capture with CDP `Page.captureScreenshot` through the e2e harness
(`apps/desktop/e2e/harness.ts`) against the built app in its isolated
fixture profile. macOS `screencapture` can come back blank: the app hides
its windows from screen capture.

1. `pnpm --filter @calendar/desktop build`.
2. Write a throwaway spec as `apps/desktop/e2e/_shot.e2e.ts` (names
   starting with `_` are gitignored). Copy the shape of
   `apps/desktop/e2e/websiteShots.e2e.ts`: `launchApp(seed, { google:
   { fixture }, model: 'fixture', … })`, `Emulation.setDeviceMetricsOverride`
   with `deviceScaleFactor: 2` for a sharp image, drive to the state with
   the harness helpers the PR's own spec uses (`openEditor`,
   `openInspector`, `locate`), wait for the text you want in the shot, then
   `Page.captureScreenshot` and write the PNG to a scratch folder. A
   `clip` to one element (`[data-testid="editor"]`) works for a panel; a
   tall element is mostly empty, so crop a full-window shot instead:
   `sips -c <height> <width> --cropOffset <y> <x> in.png --out out.png`.
   An offset of `0 0` means centered, not the top-left corner: use `1`
   for an edge.
   - Pin the spec's zone (`env: { TZ: 'Europe/Vienna' }`), or the Time
     Zones row shows the machine's own city.
   - A to-do from Reminders needs the Reminders account in the seed
     (`APPLE_REMINDERS_ACCOUNT_ID`), or it draws as an event.
   - A phrase equal to a field's placeholder reads as typed text: pick
     another.
3. Dark: `Emulation.setEmulatedMedia` with
   `prefers-color-scheme: dark`, then
   `cdp.waitUntilRendered(() => document.documentElement.dataset['theme'] === 'dark')`
   before the capture.
   A background window takes the emulated scheme only once it draws a
   frame.
4. Run it: `E2E=1 pnpm exec vp test run apps/desktop/e2e/_shot.e2e.ts`.
5. Before: the same spec in a detached worktree of `origin/main`
   (`git worktree add --detach <scratch>/main-before origin/main`,
   `pnpm install --frozen-lockfile`, build, run), then remove the worktree.

## iOS

The repacked e2e build with this branch's JS, the same way CI runs it
(no Metro, no dev launcher). From `apps/ios`:

1. The native fingerprint of the dev variant:
   `APP_VARIANT=development npx expo-updates fingerprint:generate --platform ios | jq -r .hash`.
2. Fetch the finished `e2e-simulator` build for it:
   `bash e2e/ci/fetch-eas-build.sh <hash> e2e-simulator <scratch>/eas --wait-only`.
   `--wait-only` never requests a build. No build for a new fingerprint
   means the PR changed native code: ask Nik before requesting one
   (`docs/distribution.md` → Simulator dev client).
3. Embed this branch's JS with the switches CI uses (its "Embed this
   commit's JS" step in `.github/workflows/ci.yml` is the reference):
   `EXPO_PUBLIC_CALENDAR_GEO=off EXPO_PUBLIC_CALENDAR_GOOGLE=fixture EXPO_PUBLIC_CALENDAR_MODEL=fixture EXPO_PUBLIC_CALENDAR_ONBOARDING=off EXPO_PUBLIC_CALENDAR_NOTIFICATIONS=off bash e2e/ci/repack-app.sh <scratch>/eas/Solunivo.app <scratch>/repacked/Solunivo.app`.
   The values are inlined into the bundle: change one, repack again.
   Leave `EXPO_PUBLIC_CALENDAR_GEO` out only for a shot of a live map.
4. Install on the booted simulator (uninstall what is there first):
   `UDID=$(xcrun simctl list devices booted -j | jq -r '[.devices[][]] | .[0].udid')`,
   `xcrun simctl uninstall "$UDID" com.solunivo.app.dev`, then
   `SIMULATOR_UDID=$UDID bash e2e/ci/prepare-simulator.sh install <scratch>/repacked/Solunivo.app`
   (grants Reminders, Contacts and Calendars, quiets the keyboard).
5. Drive to the state with the PR's Maestro flow or the simulator tool,
   then `xcrun simctl io booted screenshot <scratch>/ios-after.png`. A
   flow's own `takeScreenshot` takes a bare name written in the flow
   (`takeScreenshot: ios-after`): it expands no `-e` variable in the path
   and refuses a path outside its run's folder. Run it with
   `--test-output-dir <scratch>` and copy the file from there.
6. Before: repack from a detached worktree of `origin/main` the same way.
7. Dark: `xcrun simctl ui booted appearance dark`, capture, then `light`.

The fixture model reads its own pipe grammar, so a phrase bubble in a shot
reads like `Title | +1 | 13:00-14:00`; say so in the PR. In it plain words
change nothing and `invite <name>` is a change, which makes a natural
"nothing changed" shot. `EXPO_PUBLIC_CALENDAR_SPEECH=fixture` plays the
script in `apps/ios/src/fixtureSpeech.ts`, and hands-free says every entry
in a row: cut it to one entry for a shot. A Metro-driven
dev client is the other way (the `development-simulator` build plus
`EXPO_PUBLIC_*` flags on `expo start --clear`); the `ios-simulator` skill
covers it.

## States the app won't show on its own

A temporary edit, never committed:

- Reading or failing: a delay or a `throw new Error('FAILME')` in the
  renderer's `desktopModel.generateJson` or iOS `apps/ios/src/model.ts`
  (the preload's contextBridge object can't be patched from CDP).
- An iOS model-availability state: `Object.assign(languageModel,
  { availability: fake })` in `apps/ios/src/model.ts`.
- Layout: a temporary absolute overlay with red borders shows where boxes
  sit; measure the PNG with `sharp` (a root dev dependency).

Website pages are about 14k px tall at 2×: stack crops of the changed
regions instead of whole pages.

## Hosting

Images live on the `pr-screenshots` orphan branch, one folder per PR
branch (slashes become dashes: `todo/discard-confirm` →
`todo-discard-confirm`). Never commit them to the feature branch. With
`$SCRATCH` a scratch folder outside the repo:

```bash
WT="$SCRATCH/pr-screenshots"
if git fetch -q origin pr-screenshots 2>/dev/null; then git worktree add -q -B pr-screenshots "$WT" FETCH_HEAD; else git worktree add -q --orphan -b pr-screenshots "$WT"; fi
mkdir -p "$WT/<branch-slug>" && cp <images> "$WT/<branch-slug>/"
git -C "$WT" add <branch-slug> && git -C "$WT" commit -q --no-verify -m "Screenshots for <branch>"
git -C "$WT" push -q origin pr-screenshots && git worktree remove "$WT"
```

Reference each image as
`https://github.com/nikgraf/calendar/blob/pr-screenshots/<branch-slug>/<file>.png?raw=true`
(works while the repo is private too).
