#!/usr/bin/env bash
# Embed the working tree's JS into the EAS `e2e-simulator` build: the
# native half is built once per fingerprint (fetch-eas-build.sh), the JS
# half is bundled here on every run and swapped into a copy of that app.
# The result starts from its own main.jsbundle — no Metro, no dev
# launcher. EXPO_PUBLIC_* variables are inlined into the bundle, so set
# them for this script (CI: EXPO_PUBLIC_CALENDAR_GOOGLE=fixture).
#
#   repack-app.sh <source .app> <output .app>      (run from apps/ios)
set -euo pipefail

SRC="${1:?path to the source .app}"
OUT="${2:?path to the repacked .app}"

rm -rf "$OUT"
mkdir -p "$(dirname "$OUT")"
# --js-bundle-only: the native config is the fingerprint's and stays as
# built; without it repack-app runs a whole `expo prebuild`.
APP_VARIANT=development pnpm exec repack-app --platform ios --js-bundle-only \
  --source-app "$SRC" --output "$OUT" \
  --working-directory "$(dirname "$OUT")/repack-work"

# expo-updates off: with it on, a launch would ask EAS for an update of
# this runtime version and the next launch would run that instead of the
# bundle under test.
plutil -replace EXUpdatesEnabled -bool NO "$OUT/Expo.plist"
# The edits above invalidate the build's signature; a simulator accepts an
# ad-hoc one.
codesign --force --sign - "$OUT"
echo "Repacked app ready at $OUT"
