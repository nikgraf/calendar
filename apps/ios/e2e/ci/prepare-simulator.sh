#!/usr/bin/env bash
# Boot the newest available iPhone simulator, install the dev client and
# pre-grant Reminders so EventKit's prompt never appears (simctl privacy
# is the supported way to answer TCC on a simulator). Exports
# SIMULATOR_UDID for the Maestro step.
set -euo pipefail

APP="${1:?path to the .app}"
UDID=$(xcrun simctl list devices available -j | jq -r '
  .devices | to_entries
  | map(select(.key | test("iOS")))
  | sort_by(.key) | last | .value
  | map(select(.isAvailable and (.name | test("^iPhone"))))
  | .[0].udid // empty')
test -n "$UDID" || { echo "::error::no available iPhone simulator"; exit 1; }
echo "Simulator: $UDID"

xcrun simctl boot "$UDID" 2>/dev/null || true
xcrun simctl bootstatus "$UDID" -b
xcrun simctl install "$UDID" "$APP"
xcrun simctl privacy "$UDID" grant reminders com.solunivo.app
# expo-dev-menu preferences (UserDefaults keys from DevMenuPreferences.swift):
# no floating "Dev tools" button — it sits exactly over the app's own
# settings gear and steals the tap — and no first-launch onboarding or
# menu-at-launch sheets, which cover the app until dismissed.
for pref in "EXDevMenuShowFloatingActionButton -bool false" \
            "EXDevMenuIsOnboardingFinished -bool true" \
            "EXDevMenuShowsAtLaunch -bool false"; do
  # shellcheck disable=SC2086
  xcrun simctl spawn "$UDID" defaults write com.solunivo.app $pref
done
echo "SIMULATOR_UDID=$UDID" >> "${GITHUB_ENV:-/dev/null}"
