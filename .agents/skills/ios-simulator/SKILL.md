---
name: ios-simulator
description: Procedures for driving the iOS simulator in this repo — reproduce CI's iOS Maestro job locally with the exact EAS build, install the dev client that matches the working tree, run Metro and single Maestro flows, get a clean app state, hunt the race behind a flaky flow, record a one-frame glitch, diagnose a hang with lldb, probe real EventKit semantics, check a local notification end to end, and put a JS-only PR on an iPhone. Use when an iOS e2e flow fails on CI or locally, when the simulator app behaves oddly (stale JS, a blank screen, missing or leftover data), or before any hands-on check of the iOS app. PR screenshots are the ship-pr skill's.
---

# iOS simulator

Everything here runs from `apps/ios` against the booted simulator. Flow
conventions and CI flake signatures: `docs/google-sync-and-testing.md`
(iOS e2e, CI). Why the app or Metro behaves oddly:
`docs/platform-notes.md`. Build profiles, the two variants, TestFlight:
`docs/distribution.md`. Screenshots for a PR: the `ship-pr` skill.
The deeper probes (race hunts, recordings, lldb, EventKit, notifications,
a PR on a phone) are in [PROBES.md](PROBES.md).

## Setup

```sh
cd apps/ios
UDID=$(xcrun simctl list devices booted -j | jq -r '[.devices[][]] | .[0].udid // empty')
APP=com.solunivo.app.dev   # every e2e and dev build is the dev variant
FP=$(APP_VARIANT=development npx expo-updates fingerprint:generate --platform ios | jq -r .hash)
SCRATCH=<your scratch directory>   # logs, set-aside databases, probe files
```

- Nothing booted: `bash e2e/ci/prepare-simulator.sh boot` starts the
  one CI uses (an iPhone 18 Pro on the selected Xcode's iOS runtime; not
  the iPhone Duo, whose runtime of its own sorts last), then
  `UDID=<the udid it printed>` and `xcrun simctl bootstatus "$UDID"`.
  Use that one simulator for everything; erase it (Clean state) rather
  than create another.
- The app's database is `$(xcrun simctl get_app_container "$UDID" $APP
  data)/Library/calendar.db`. It has no WAL file: read it live with
  `sqlite3 -readonly`, copy it live. The container path changes with every
  install, so look it up again after one.
- Maestro needs a JDK on PATH (AGENTS.md → Commands). `xcrun simctl io
  "$UDID" screenshot out.png` is the dependable way to look at the screen.
- Use `pnpm exec eas` (the CLI pinned in `apps/ios`); it needs an EAS login
  (`EXPO_TOKEN`). A global eas-cli prints its "now available" notice into
  `--json` output and `jq` fails with "Invalid numeric literal" (filter
  with `sed -n '/^[\[{]/,$p'`).

## Which build to install

| Build                   | What it is                                                                | Use it for                                                       |
| ----------------------- | ------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `e2e-simulator`         | Release build; `repack-app.sh` embeds your JS; no Metro, expo-updates off | what CI runs: reproducing a CI failure, flow runs without Metro  |
| `development-simulator` | the dev client, loads JS from Metro                                       | console logs, quick reloads, probes, the live suite, website shots |

EAS builds both per native fingerprint. A branch with no native change
shares main's fingerprint, so once CI ran on main a finished build exists:

```sh
bash e2e/ci/fetch-eas-build.sh "$FP" e2e-simulator build/e2e-app --wait-only
bash e2e/ci/fetch-eas-build.sh "$FP" development-simulator build/devclient --wait-only
```

`--wait-only` never requests a build; it waits up to ten minutes for one
another job asked for, then fails. Without it the script requests a build
when none exists, which costs one of the month's EAS builds: do that only
for a new native fingerprint, or build locally instead
(`docs/distribution.md` → Local Xcode build). `build/` is gitignored.

Install either one over a clean slate:

```sh
xcrun simctl uninstall "$UDID" $APP
SIMULATOR_UDID=$UDID bash e2e/ci/prepare-simulator.sh install build/<dir>/Solunivo.app
```

`prepare-simulator.sh install` grants Reminders, Contacts and Calendars,
switches off the dev menu's floating button (it sits over the account
button) and its onboarding sheets, and turns keyboard predictions and
autocorrect off. Run it with bash: its `defaults write` loops fail under
zsh ("Rep argument is not a dictionary").

Is the installed dev client current? `pnpm --filter @calendar/ios check:devclient` compares its
fingerprint with the working tree's. A stale one crashes at bundle load
or misses a module (`platform-notes.md` → Expo, Metro and the dev client).

## Reproduce CI's iOS job

The exact binary CI used is the one for the fingerprint in the failing
job's "Native fingerprint" step (`fingerprint: <hash>`); set `FP` to it.

```sh
bash e2e/ci/fetch-eas-build.sh "$FP" e2e-simulator build/e2e-app --wait-only
EXPO_PUBLIC_CALENDAR_GEO=off EXPO_PUBLIC_CALENDAR_GOOGLE=fixture \
  EXPO_PUBLIC_CALENDAR_MODEL=fixture EXPO_PUBLIC_CALENDAR_ONBOARDING=off \
  EXPO_PUBLIC_CALENDAR_NOTIFICATIONS=off \
  bash e2e/ci/repack-app.sh build/e2e-app/Solunivo.app build/e2e-repacked/Solunivo.app
xcrun simctl uninstall "$UDID" $APP
SIMULATOR_UDID=$UDID bash e2e/ci/prepare-simulator.sh install build/e2e-repacked/Solunivo.app
SIMULATOR_UDID=$UDID node e2e/ci/run-flows.ts permissions e2e/flows/04a-device-permissions.yaml
SIMULATOR_UDID=$UDID node e2e/ci/run-flows.ts shard1 $(node e2e/ci/shard-flows.mjs 1 2)
```

- The env block is the one in `.github/workflows/ci.yml`'s "Embed this
  commit's JS" step; check it there if a flag was added since. CI also
  gives Maestro's driver 240 s to start (`MAESTRO_DRIVER_STARTUP_TIMEOUT=240000`).
- The repack takes about a minute and embeds the working tree's JS:
  repack again after every app-code change.
- CI's simulator is freshly booted and empty. For CI's exact start, erase
  first (Clean state, step 3): EventKit data survives an uninstall.
- One flow: `maestro --device "$UDID" test e2e/flows/<flow>.yaml; echo
  $?`. Without `E2E_APP`, `run-flows.ts` reruns a lost flow without
  resetting anything; each attempt's output is in
  `~/.maestro/tests/<label>-<n>/`.
- CI runs iOS 27.2 on an iPhone 18 Pro (Xcode 27.2), as a local run
  does. XCTest's typing hides the keyboard while the field keeps focus
  (`common/dismiss-keyboard.yaml` taps twice for it), and the Search tab
  opens with its field active.

## Run against Metro (dev client)

```sh
bash e2e/ci/fetch-eas-build.sh "$FP" development-simulator build/devclient --wait-only
xcrun simctl uninstall "$UDID" $APP
SIMULATOR_UDID=$UDID bash e2e/ci/prepare-simulator.sh install build/devclient/Solunivo.app
EXPO_PUBLIC_CALENDAR_GOOGLE=fixture EXPO_PUBLIC_CALENDAR_MODEL=fixture \
  EXPO_PUBLIC_CALENDAR_ONBOARDING=off EXPO_PUBLIC_CALENDAR_NOTIFICATIONS=off \
  EXPO_PUBLIC_CALENDAR_GEO=off \
  nohup pnpm start --clear > "$SCRATCH/metro.log" 2>&1 &
xcrun simctl openurl "$UDID" 'solunivo-dev://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8081'
```

- The `start` script sets `APP_VARIANT=development`, which Metro needs to
  serve the dev variant's config. Leave `EXPO_PUBLIC_CALENDAR_GEO` unset
  only for the flows that need real MapKit and the network
  (`14-location`, `30-place-map`).
- Send Metro's output to a file; never pipe `expo start` through `head`.
  It has served once the log says "iOS Bundled".
- Use `127.0.0.1`, not `localhost`. Under `CI=1` the dev client does not
  find Metro by itself: open the URL above (flow `00-devclient-bootstrap`
  does the same). After a reinstall the launcher can list Metro under the
  machine's LAN address, which `await-shell.yaml` does not match: tap that
  row once, or open the URL.
- Restart Metro with `--clear` after every JS edit, every `EXPO_PUBLIC_*`
  change and any route edit, before the next flow or probe: without
  watchman, or with `CI=1`, it serves the old JS (`platform-notes.md`).
- `simctl launch` (or a simulator tool's launch) on a running app only
  brings it forward: `xcrun simctl terminate "$UDID" $APP` first.
- `pnpm test:e2e:ios` from the root checks the client, then runs every
  local flow against this setup.
- `pnpm start --no-dev --minify` serves a production bundle to the same
  dev client: CI-like JS without another install, but no logs.

## Clean state

From lightest to heaviest:

1. **App data.** Terminate the app and move the database aside; the next
   launch seeds the fixture account again and syncs a fresh fixture.

   ```sh
   xcrun simctl terminate "$UDID" $APP
   LIB="$(xcrun simctl get_app_container "$UDID" $APP data)/Library"
   mkdir -p "$SCRATCH/db-aside" && mv "$LIB"/calendar.db* "$SCRATCH/db-aside/"
   ```

   Reach for it when date-relative fixture items are gone (flow 24's
   weekly "Kolkata series" days later: the database keeps the fixture's
   rows from its first sync, and a fresh fake's sync tokens return
   nothing newer); when the Calendar tab draws its tab bar but no "Today"
   after another branch's JS ran (a migration this JS lacks: `sqlite3
   -readonly "$LIB/calendar.db" 'select * from effect_sql_migrations'`);
   when a failed `04a` left the Apple account connected (the next `04a`
   then fails partway); when an earlier run left Reminders connected.

2. **App and permissions.** `xcrun simctl uninstall "$UDID" $APP`,
   `xcrun simctl privacy "$UDID" reset all $APP`, then install again with
   `prepare-simulator.sh install`.

3. **The device.** `xcrun simctl shutdown "$UDID"; xcrun simctl erase
   "$UDID"`, boot, install. Needed because the device's Calendar and
   Reminders (EventKit) survive an uninstall, and because only a freshly
   erased device shows the "Open in Solunivo Dev?" alert for an opened
   link (the path flow 22 takes on CI).

**Leftovers from a flow cut short.** Flows clean up at their end, so a run
that died mid-flow (a lost driver, a dropped tap, a stop by hand) fails
that flow's next run with an unrelated-looking error. Look at the failure
screenshot for leftover data before suspecting the app:

- flow 19 leaves a stored `Pacific/Honolulu`: the picker then says "No
  time zone matches “Honolulu”" and `time-zone-option-Pacific-Honolulu`
  is not found. Swipe its row left and tap
  `time-zone-remove-Pacific-Honolulu`.
- flow 09 leaves "Solunivo e2e reminder to delete" rows, which are
  EventKit reminders (a reinstall keeps them). Delete them with a
  selector that allows the row's "!!! " prefix and ", due …" suffix.
- flow 07 leaves its event in Mock Calendar, and flow 21 then counts one
  more mirrored event.
- A calendar made through the fixture account ("New calendar…"): the
  fake forgets it at the next launch, but `calendar.db` keeps its
  `calendars` row and a `sync_state` row whose `scope` holds its id. With
  the app terminated, delete both by that id
  (`created-<n>@group.calendar.google.com`), then run `pragma
  integrity_check`.

Clean up through the UI with a scratch flow, or take step 1 or 3.

**Seeding rows by hand.** With the app terminated, a throwaway
`apps/desktop/e2e/_seed.e2e.ts` (never committed) can call the desktop
harness's `seedDatabase(<app container>/Library, seed)`: the iOS app reads
the same `calendar.db` schema. The fixture Google account has one task
list ("Mock Tasks"); a check that needs a second one (the Tasks tab's
filter chips) connects Reminders.

The fixture Google API lives in the app's JS runtime and starts over at
each launch: a write to an event created before a relaunch drops that
event (it looks like a vanish). Create test events after the last
relaunch; the fixture's recurring instances revert after any drag.

## Maestro by hand

- One flow: `maestro --device "$UDID" test e2e/flows/<flow>.yaml; rc=$?`.
  A single-file run prints no `[Passed]` / `[Failed]` line (only a
  directory run does): judge by the exit code.
- Kill a stale Maestro JVM before a run: a killed run's JVM keeps the
  driver, and the next run fails within a minute. `pkill -f
  '[m]aestro.cli.AppKt'` (the brackets keep a polling loop's own command
  line from matching itself).
- Maestro stops the app when a run ends; a probe after it launches again.
- The live screen with every element's bounds: `maestro --device "$UDID"
  hierarchy` (JSON). It once bounced the dev client to its launcher:
  reopen the Metro URL.
- `takeScreenshot` takes a bare name written in the flow
  (`takeScreenshot: probe`): no `-e` variable is expanded in it, and a
  path outside its run folder is refused. The file lands in
  `~/.maestro/tests/<run>/<flow name>/takeScreenshot/probe.png`, or under
  the folder `--test-output-dir <dir>` names.
- Scratch flows live in the scratchpad, never in `e2e/flows/` (CI shards
  every `ci` flow there, and a directory runs in any order). They start
  with `appId: com.solunivo.app.dev` and reach the shared subflows by
  absolute path (`runFlow: <checkout>/apps/ios/e2e/common/launch.yaml`).
  One that drives an app already on screen starts with `launchApp: {
  stopApp: false }`; without a launch, its "Search" tap opened Spotlight
  on the home screen.
- Run nothing heavy beside a Maestro run whose result matters: next to the
  desktop e2e suite, flows took twice as long and lost taps.
- A hang: when the app's CPU stays above 90 % for ~18 s (`ps -axo
  %cpu=,comm= | grep -i solunivo`), stop Maestro instead of waiting out its
  30 s "main thread busy" retries, and read the loop with lldb
  ([PROBES.md](PROBES.md)).
- A crash report lands in `~/Library/Logs/DiagnosticReports/Solunivo*.ips`
  a minute or so after the process died; Maestro's simulator log shows
  only the exit.

## Driving the simulator by hand

With a simulator tool, if the session has one, or `simctl`:

- Screenshots lag the app by about a second: after a tap, wait 1.5 s,
  then `xcrun simctl io "$UDID" screenshot`. A tap that looks ignored has
  often landed. Crop with `sips -c <height> <width> --cropOffset <y> <x>
  in.png --out out.png`; an offset of `0 0` falls back to a centered crop,
  so crop from the top-left corner with `--cropOffset 1 1`.
- An `@expo/ui` SwiftUI switch ignores a plain tap; a tap held 0.15 s
  flips it. Read the outcome from `device_settings` in `calendar.db`, not
  from the screen.
- Leave about a second between taps: a second tap sent right after the
  first can be dropped.
- A tool's swipe across the day timeline holds long enough to fire the
  300 ms hold-to-create, and a New Event editor opens. Drive swipes with a
  Maestro `swipe` and `duration: 250`.
- Event move and resize drive with a touch path: a first sample, the same
  point again 600 ms later, moves 100 ms apart, then repeated samples to
  hold before the lift; a screenshot afterwards shows the committed time.
  Nothing here starts a task chip's long-press drag, on main either, so
  "no change" proves nothing: report the drag as unverified and ask for
  the device check in `docs/google-sync-and-testing.md` (end of iOS e2e).
- Typing: a tool's text action pastes and mangles non-ASCII ("ü" →
  "√∞"), so use ASCII phrases. Text typed into the quick-add field while
  its sheet still expands loses its tail: wait ~3 s after tapping the
  field, type, check the field, type what is missing. Typing into a field
  that lost focus can trigger dev-menu shortcuts (the element inspector
  opened): relaunch.
- To give a fixture event real times, hold on the grid (the editor opens
  on that slot) rather than typing a phrase.
- A simulator a tool booted may be shut down about ten minutes after the
  tool lets go of it: `xcrun simctl boot` it again.
- Appearance: `xcrun simctl ui "$UDID" appearance dark` (or `light`).
  Reduce Motion: `xcrun simctl spawn "$UDID" defaults write
  com.apple.Accessibility ReduceMotionEnabled -bool true`, then relaunch the
  app (Reanimated's `useReducedMotion` reads it once); write `false` after.
- Motion: stills cannot show it. `xcrun simctl io "$UDID" recordVideo
  --codec h264 --force rec.mp4 &`, stop it with `pkill -INT -f recordVideo`,
  then lay frames side by side with ffmpeg (`fps=6,crop=…,tile=8x3`) to read
  them, or make a GIF for a PR (`palettegen` / `paletteuse`).
