#!/usr/bin/env bash
# Check the signed artifact, not just the source plist: hardened runtime
# refuses to show permission prompts when these entitlements are missing.
set -euo pipefail

APP="${1:?path to Solunivo.app}"
ENTITLEMENTS=$(mktemp)
trap 'rm -f "$ENTITLEMENTS"' EXIT

require_entitlements() {
  local binary="$1"
  shift
  codesign --display --entitlements - --xml "$binary" > "$ENTITLEMENTS"
  for key in "$@"; do
    if [ "$(/usr/libexec/PlistBuddy -c "Print :$key" "$ENTITLEMENTS" 2>/dev/null)" != true ]; then
      echo "::error::$binary is missing the $key entitlement"
      exit 1
    fi
  done
}

for binary in "$APP" "$APP/Contents/Resources/solunivo-model-helper"; do
  require_entitlements "$binary" com.apple.security.personal-information.addressbook com.apple.security.personal-information.calendars
done
# The app itself opens the camera (the settings code reader); the helper
# only reads the frames it is sent.
require_entitlements "$APP" com.apple.security.device.camera
