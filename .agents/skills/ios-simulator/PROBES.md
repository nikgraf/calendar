# iOS simulator probes

Deeper procedures for the `ios-simulator` skill. Setup (`UDID`, `APP`,
`FP`, Metro) is in [SKILL.md](SKILL.md). Every temporary patch below is
scratch: never commit it, and take it out before the flow that decides
anything.

## Hunting the race behind a flaky flow

First rule out the catalog in `docs/google-sync-and-testing.md` (CI →
"Reading a red macOS job") and read the failed shard's artifact. Its
`e2e-app-state/calendar.db` tells a stale screen from a lost write: the
row present with an `updated_at` at the action means the screen was
stale; no row, or one stamped during a later flow, means the write was
lost. Then, cheapest first:

1. **Node replays** (minutes, thousands of interleavings). Compose the
   app's layers the way `packages/sync/src/testing/googleFixture.test.ts`
   does — `SyncEngine.layer`, `EventMutations.layer`, the repos,
   `SqliteClient`, `googleFixtureLayer(<fixture>)`,
   `makeFakeRemindersClient` — and run a hot `syncAll` loop beside the
   mutation, varying `Scheduler.MaxOpsBeforeYield` (4 or more; at 1–2
   every iteration times out). For the UI half, wrap the real
   `commonBackendHandlers` in a Proxy client with `forwardingReactivity`,
   then `makeBackendAtoms` + `AtomRegistry` + `runMutation`. A shard
   replay is a file database with a fresh `ManagedRuntime` per "launch"
   (the fake restarts its `task-N` ids every launch). Print to
   `process.stderr`: vitest hides a passing test's output.
2. **Sync-pass amplifier on the simulator.** A temporary patch in the
   editor model (`taskEditorModel` for a task) fires
   `mutations.syncNow()` at a random −200…+200 ms around the mutation.
   Keep the default 90 s poll: a hot poll
   (`EXPO_PUBLIC_CALENDAR_SYNC_INTERVAL_MS`) heals a lost row within a
   second and hides the symptom CI saw.
3. **Native-lag amplifier.** Wrap the transport's `invoke` in
   `apps/ios/src/<x>Client.ts` (`remindersClient.ts`,
   `appleCalendarClient.ts`, …) to answer as a lagging OS would: `status`
   still `notDetermined`, reads rejected with the module's exact Expo
   error message, after a delay that stands in for CI's slower pass.
   Locally Maestro finds elements ~0.8 s sooner after a system alert than
   on CI, so shrink delays taken from CI logs.
4. **Probes.** `console.warn('[dbg] …')` on repository writes and
   handlers, read in Metro's log (a dev bundle; Effect's logger never
   reaches Metro). For touches and the keyboard, the probe set in
   `platform-notes.md` → Touches and the responder system.
5. **Loop the flow** with a clean state between runs (SKILL.md → Clean
   state): a run killed mid-flow leaves reminders and event rows that a
   fresh fake never tombstones, and the next run matches those first.

To prove CI's in-job retry instead: `pkill -9 -f
maestro-driver-iosUITests-Runner` while a flow types latches Maestro's
"device unreachable" the way a dead driver does; stopping the app with
SIGSTOP does not (the iOS keyboard runs out of process).

## Recording a one-frame glitch

```sh
xcrun simctl io "$UDID" recordVideo --codec h264 --force out.mp4 &
REC=$!
# drive the gesture (a Maestro flow), then
kill -INT $REC
mkdir -p frames
ffmpeg -i out.mp4 -fps_mode passthrough -vf scale=402:-1 frames/%04d.png
ffprobe -v error -show_entries frame=pts_time -of csv=p=0 out.mp4 > times.txt
```

- The video has a variable frame rate (only changed frames are stored),
  so `-fps_mode passthrough` keeps one PNG per real frame and `times.txt`
  their timestamps. Scale to points (402 wide on a 17 Pro) for layout
  questions; keep the full 1206 px for sub-pixel ones.
- Compare frames with Pillow and numpy in a scratch virtualenv. A useful
  check: at a swipe's page change (the title row changes) the time grid's
  region must not change at all. Two frames ~1.7 ms apart with zero
  difference are a recorder artifact, not a drop.
- A fade or transition was drawn when its span shows a run of ~16 ms
  frames. The worst case is the first open after launch: record that one.
- Drive swipes with Maestro (`swipe` with `duration: 250`): a simulator
  tool's touch-down lasts long enough to fire 250–300 ms long presses.
- A GIF of the recording: ffmpeg's `palettegen` / `paletteuse` filters.

## Diagnosing a hang with lldb

A main-thread layout loop can be read live, without stopping the app for
long. Find the pid (`ps -axo pid,%cpu,comm | grep -i solunivo`), then
write a command file:

```
settings set interpreter.stop-command-source-on-error false
expr @import UIKit
breakpoint set -n "-[RCTEnhancedScrollView setContentOffset:]" -G true -C "p/x $x0" -C "p $d1"
continue
```

```sh
perl -e 'alarm 20; exec @ARGV' lldb -p "$PID" --batch -s cmds.txt > lldb.log 2>&1
```

- `-G true` auto-continues, so each hit prints and runs on; on arm64
  `$x0` is `self` and `$d0`/`$d1` hold a `CGPoint` argument. Pick the
  selector from the loop's frames (a first `bt` in a stopped attach).
- `po [[(UIView *)0x… superview] accessibilityIdentifier]` turns a view
  address into the React Native testID.
- macOS has no `timeout`; the `perl … alarm` wrapper ends lldb after 20 s.
  Relaunch the app afterwards if it did not survive the detach.
- Restart Metro with `--clear` before every experiment, so the JS under
  test is the JS you just edited.

## Probing real EventKit semantics

A question such as "can a detached occurrence sit more than 31 days from
its slot?" is settled on the simulator's own EventKit store in minutes,
with no Xcode project and no app in front, and without touching any
real calendar:

1. `main.swift` with EventKit: create a temporary calendar on the
   `.local` source, run the experiment, `print` the results, remove the
   calendar, `exit(0)`. Give it modes when a dev-client check follows:
   `seed` (a calendar and a series dated relative to today, so the Day
   view shows them), `add`, `shift` (a series-wide time change, which
   makes identifiers stale), `dump` (read the store back) and `clean`.
2. Build for the simulator:

   ```sh
   mkdir -p Probe.app
   xcrun swiftc -sdk "$(xcrun --sdk iphonesimulator --show-sdk-path)" \
     -target arm64-apple-ios26.0-simulator main.swift -o Probe.app/Probe
   ```

   (A "sysroot for macOS" clang warning is noise; `vtool -show-build
   Probe.app/Probe` says IOSSIMULATOR.)
3. `Probe.app/Info.plist` with `CFBundleExecutable` = `Probe`, a bundle id
   of its own and `NSCalendarsFullAccessUsageDescription` (or the
   reminders key); then `codesign -s - --force Probe.app`.
4. Install, grant, run:

   ```sh
   xcrun simctl install "$UDID" Probe.app
   xcrun simctl privacy "$UDID" grant calendar <probe bundle id>
   xcrun simctl spawn "$UDID" "$(xcrun simctl get_app_container "$UDID" <probe bundle id> app)/Probe" probe
   ```

   The grant by bundle id applies to the spawned binary. Wrap the spawn
   in `perl -e 'alarm 60; exec @ARGV'` so a hang cannot hold the shell.
5. Afterwards remove the probe's calendars (its `clean` mode), `xcrun
   simctl uninstall "$UDID" <probe bundle id>` and `xcrun simctl privacy
   "$UDID" reset calendar <probe bundle id>`.

For an end-to-end check, `seed` the store, connect Apple Calendar in the
dev client (Settings › On This iPhone), act in the app and `dump` after
every action: EventKit read back is the proof, not the app's screen.
Disconnect and `clean` afterwards. What this finds is the simulator's
local source only (macOS, iCloud and Exchange stay unverified); record
it in `docs/google-sync-and-testing.md` → Apple Calendar semantics.

## Checking a local notification end to end

Maestro cannot see Notification Center, so this stays a manual check.

1. Start Metro without `EXPO_PUBLIC_CALENDAR_NOTIFICATIONS=off` (the
   flows' setting leaves expo-notifications out), on the Google fixture.
2. Seed instead of driving the editor (its "Calendar default" SwiftUI
   switch ignores scripted taps): with the app terminated, insert an event
   a few minutes ahead with a reminder at its start.

   ```sh
   DB="$(xcrun simctl get_app_container "$UDID" $APP data)/Library/calendar.db"
   NOW=$(($(date +%s) * 1000)); START=$((NOW + 3 * 60 * 1000))
   sqlite3 "$DB" "insert into events (account_id, calendar_id, id, status, title,
     is_all_day, start_utc, end_utc, reminders, sync_status, updated_at, synced_at)
     values ('fixture-google', 'mock-calendar', 'notify-check-1', 'confirmed',
     'Notification check', 0, $START, $((START + 30 * 60 * 1000)),
     '{\"overrides\":[{\"method\":\"popup\",\"minutes\":0}],\"useDefault\":false}',
     'synced', $NOW, $NOW)"
   ```

3. `xcrun simctl launch "$UDID" $APP`: the pass at launch schedules it. The
   first schedule asks for notification permission (allow it). Confirm
   with `select value from device_settings where key =
   'localNotifications.scheduled'`.
4. When it fires, open Notification Center with a swipe from the top edge
   down (from about (200, 2) to (200, 600) in points); a second swipe up
   from mid-screen shows older ones. Look with `xcrun simctl io "$UDID"
   screenshot` after 1.5 s.
5. Delete the seeded row (`delete from events where id =
   'notify-check-1'`) with the app terminated.

## Putting a JS-only PR on an iPhone

The fast path is the PR's OTA preview in the installed TestFlight app,
not a device build. CI publishes it on every push (`pr-<n>`, a few
minutes after the push); the person with the phone loads it under
Settings › Advanced › PR Preview (`docs/distribution.md` → One install per
variant describes that page). It loads only when the update's runtime
equals the installed build's, so check that before asking anyone to try:

```sh
cd apps/ios
pnpm exec eas build:list --platform ios --build-profile testflight --status finished \
  --limit 1 --json --non-interactive | jq -r '.[0].runtime.version'   # what TestFlight runs
env -u APP_VARIANT npx expo-updates fingerprint:generate --platform ios | jq -r .hash   # the branch
pnpm exec eas update:list --branch pr-<n> --json --non-interactive    # after the push
```

- Different hashes with no native change on the branch: the TestFlight
  build is natively newer than the branch's base. Merge `origin/main`
  (when main has no native change after that build), push, and wait for
  the new preview. A native change on the branch needs the `testflight`
  label instead.
- Prove the channel serves this runtime before handing it over:

  ```sh
  curl -s -o /dev/null -w '%{http_code}\n' "$(jq -r .expo.updates.url app.json)" \
    -H 'expo-platform: ios' -H 'expo-runtime-version: <build runtime>' \
    -H 'expo-channel-name: pr-<n>' -H 'expo-protocol-version: 1'
  ```

  200 is a manifest. A 404 "There is no channel named pr-<n>" means CI
  has not published for that PR yet: wait for its preview job, or push
  again.
- With a phone attached to the machine, `xcrun devicectl device info apps
  --device <device id>` lists the installed build. A dev-variant device
  build is the slow path (an ad hoc profile that must list the phone and
  an interactive Apple login; `docs/distribution.md` → Device dev client):
  only when Metro logs from a real device are needed.
