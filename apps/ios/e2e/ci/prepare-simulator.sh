#!/usr/bin/env bash
# Boot the newest available iPhone simulator, install the app and
# pre-grant Reminders, Contacts and Calendars so no prompt appears (simctl
# privacy is the supported way to answer TCC on a simulator), and quiet the
# keyboard's predictions and apsd's log flood. Exports SIMULATOR_UDID for
# the Maestro step.
#
#   prepare-simulator.sh boot           start the boot, do not wait for it
#   prepare-simulator.sh install <app>  wait for the boot, install, grant
#   prepare-simulator.sh reset <app>    erase the booted simulator, then
#                                       install as above (run-flows.ts,
#                                       before a second run; CI only)
#
# The split lets a job start the boot first: a runner's first boot spends
# two minutes in data migration, which then overlaps the install and the
# bundling instead of preceding them. Run them as separate steps, never
# back to back: `install` right after `boot` raced the boot it had just
# started (see install below).
set -euo pipefail

# The dev variant (app.config.js): e2e always drives it.
BUNDLE_ID="com.solunivo.app.dev"

boot() {
  UDID=$(xcrun simctl list devices available -j | jq -r '
    .devices | to_entries
    | map(select(.key | test("iOS")))
    | sort_by(.key) | last | .value
    | map(select(.isAvailable and (.name | test("^iPhone"))))
    | .[0].udid // empty')
  test -n "$UDID" || { echo "::error::no available iPhone simulator"; exit 1; }
  echo "Simulator: $UDID"

  # The application firewall sees the simulated app, not Simulator.app, and
  # drops its connections to a host dev server (timeouts, never refusals);
  # the runner has no one to click "Allow". Off for the job's lifetime.
  if [ -n "${CI:-}" ]; then
    sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate || true
    sudo /usr/libexec/ApplicationFirewall/socketfilterfw --setglobalstate off || true
  fi

  # `simctl boot` itself blocks for about a minute on a fresh runner.
  nohup xcrun simctl boot "$UDID" > /dev/null 2>&1 &
  echo "SIMULATOR_UDID=$UDID" >> "${GITHUB_ENV:-/dev/null}"
  SIMULATOR_UDID="$UDID"
}

install() {
  APP="${1:?path to the .app}"
  UDID="${SIMULATOR_UDID:?run the boot step first}"
  # -b boots the device if the background boot has not got that far (or
  # failed), then waits for it. When the background boot starts the device
  # between bootstatus's check and its own boot request, CoreSimulator
  # refuses the second boot ("Unable to boot device in current state:
  # Booted", exit 149) — the boot is under way, so wait for that one.
  if ! xcrun simctl bootstatus "$UDID" -b; then
    state=$(xcrun simctl list devices -j | jq -r --arg udid "$UDID" \
      '.devices[][] | select(.udid == $udid) | .state')
    case "$state" in
      Booting | Booted) xcrun simctl bootstatus "$UDID" ;;
      *)
        echo "::error::simulator $UDID did not boot (state: ${state:-unknown})"
        exit 1
        ;;
    esac
  fi
  xcrun simctl install "$UDID" "$APP"
  xcrun simctl privacy "$UDID" grant reminders "$BUNDLE_ID"
  xcrun simctl privacy "$UDID" grant contacts "$BUNDLE_ID"
  xcrun simctl privacy "$UDID" grant calendar "$BUNDLE_ID"
  # expo-dev-menu preferences (UserDefaults keys from DevMenuPreferences.swift):
  # no floating "Dev tools" button — it sits exactly over the app's own
  # account button and steals the tap — and no first-launch onboarding or
  # menu-at-launch sheets, which cover the app until dismissed. Only the
  # dev client reads them; harmless for the embedded-bundle build.
  for pref in "EXDevMenuShowFloatingActionButton -bool false" \
              "EXDevMenuIsOnboardingFinished -bool true" \
              "EXDevMenuShowsAtLaunch -bool false"; do
    # shellcheck disable=SC2086
    xcrun simctl spawn "$UDID" defaults write "$BUNDLE_ID" $pref
  done
  # No predictions or autocorrect: typed text lands as typed, and the
  # keyboard skips the candidate work that was starting when the app's main
  # thread stuck in UIKit's keyboard queue for 90 s (run 38466668240, flow
  # 07). Checked on a simulator: the prediction bar goes away.
  for pref in "KeyboardPrediction -bool false" \
              "KeyboardAutocorrection -bool false" \
              "KeyboardShowPredictionBar -bool false"; do
    # shellcheck disable=SC2086
    xcrun simctl spawn "$UDID" defaults write com.apple.keyboard.preferences $pref
  done
  # A runner's simulator cannot activate push ("MobileActivation: Client is
  # not supported"), so apsd reconnects in a loop: about 200k log lines a
  # minute, two thirds of everything the simulator logs. Nothing here uses
  # push (the app drops aps-environment) and local notifications do not go
  # through apsd. The job stays out until the device reboots.
  xcrun simctl spawn "$UDID" launchctl bootout user/foreground/com.apple.apsd || true
  if xcrun simctl spawn "$UDID" launchctl list | grep -q com.apple.apsd; then
    echo "::warning::apsd is still running on the simulator"
  fi
}

# Back to a fresh device: an uninstall leaves the device's Reminders and
# Calendar (EventKit belongs to the device, not the app), and a flow cut
# short mid-write would meet its own half-made reminder on its rerun.
reset() {
  UDID="${SIMULATOR_UDID:?run the boot step first}"
  xcrun simctl shutdown "$UDID" || true
  xcrun simctl erase "$UDID"
  install "${1:-}"
}

case "${1:?boot | install <app> | reset <app>}" in
  boot) boot ;;
  install) install "${2:-}" ;;
  reset) reset "${2:-}" ;;
  *)
    echo "usage: prepare-simulator.sh boot | install <app> | reset <app>" >&2
    exit 2
    ;;
esac
