#!/usr/bin/env bash
# Check the signed artifact, not just the source plist: hardened runtime
# refuses to show permission prompts when these entitlements are missing.
set -euo pipefail

APP="${1:?path to Solunivo.app}"
ENTITLEMENTS=$(mktemp)
trap 'rm -f "$ENTITLEMENTS"' EXIT

for binary in "$APP" "$APP/Contents/Resources/solunivo-model-helper"; do
  codesign --display --entitlements - --xml "$binary" > "$ENTITLEMENTS"
  for key in com.apple.security.personal-information.addressbook com.apple.security.personal-information.calendars; do
    if [ "$(/usr/libexec/PlistBuddy -c "Print :$key" "$ENTITLEMENTS" 2>/dev/null)" != true ]; then
      echo "::error::$binary is missing the $key entitlement"
      exit 1
    fi
  done
done
