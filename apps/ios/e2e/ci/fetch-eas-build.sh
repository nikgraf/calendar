#!/usr/bin/env bash
# Fetch the EAS simulator build of a profile for a native fingerprint into
# an output directory (as <out>/Solunivo.app), requesting one first when
# this fingerprint has none. CI never compiles the app itself: EAS owns
# native builds (see docs/distribution.md), and the Actions cache in the
# workflows keeps the result so only a changed fingerprint reaches this
# script at all.
#
#   fetch-eas-build.sh <fingerprint> <profile> <out-dir> [--wait-only]
#
# --wait-only never requests a build: it waits for the one another job
# requests. The iOS e2e shards start together with the same new
# fingerprint; only the first may queue a build.
set -euo pipefail

FP="${1:?native fingerprint hash}"
PROFILE="${2:?EAS build profile}"
OUT="${3:?output directory}"
WAIT_ONLY="${4:-}"

list() {
  pnpm exec eas build:list --platform ios --build-profile "$PROFILE" \
    --fingerprint-hash "$FP" --status "$1" --limit 1 --json --non-interactive
}

# Sets BUILD_ID to the newest build in any live state, or leaves it empty.
# A lookup that fails ends the script rather than reading as "no build":
# this runs as an `if` condition, where errexit is off, and an EAS outage
# would otherwise request a second build for a fingerprint that has one.
find_build() {
  local status json
  BUILD_ID=""
  # Two pushes with the same new fingerprint must not queue two builds.
  for status in finished in-progress in-queue new; do
    json=$(list "$status") || { echo "::error::eas build:list ($status) failed"; exit 1; }
    BUILD_ID=$(jq -er 'if type == "array" then .[0].id // "" else error("not a list") end' <<< "$json") \
      || { echo "::error::eas build:list ($status) returned no build list"; exit 1; }
    [ -n "$BUILD_ID" ] && return 0
  done
  return 1
}

BUILD_ID=""
if ! find_build; then
  if [ "$WAIT_ONLY" = "--wait-only" ]; then
    echo "No $PROFILE build for fingerprint $FP yet — waiting for another job to request it"
    for _ in $(seq 1 20); do
      sleep 30
      find_build && break
    done
    test -n "$BUILD_ID" || { echo "::error::no $PROFILE build for fingerprint $FP appeared"; exit 1; }
  else
    echo "No $PROFILE build for fingerprint $FP — requesting one on EAS"
    BUILD_ID=$(pnpm exec eas build --platform ios --profile "$PROFILE" \
      --non-interactive --no-wait --json | jq -r '.[0].id // .id // empty')
    test -n "$BUILD_ID" || { echo "::error::eas build returned no build id"; exit 1; }
  fi
fi

echo "Build $BUILD_ID (fingerprint $FP)"
while :; do
  STATUS=$(pnpm exec eas build:view "$BUILD_ID" --json 2>/dev/null | jq -r '.status // empty')
  case "$STATUS" in
    FINISHED) break ;;
    ERRORED|CANCELED|PENDING_CANCEL) echo "::error::build $BUILD_ID ended as $STATUS"; exit 1 ;;
    *) sleep 30 ;;
  esac
done

URL=$(pnpm exec eas build:view "$BUILD_ID" --json \
  | jq -r '.artifacts.applicationArchiveUrl // .artifacts.buildUrl // empty')
test -n "$URL" || { echo "::error::build $BUILD_ID has no application archive"; exit 1; }
# With runtimeVersion policy "fingerprint", a build's runtime version IS its fingerprint.
BUILT_FP=$(pnpm exec eas build:view "$BUILD_ID" --json | jq -r '.runtime.version // empty')
echo "Downloading build $BUILD_ID (fingerprint $BUILT_FP)"

rm -rf "$OUT" && mkdir -p "$OUT"
curl -fsSL "$URL" -o "$OUT/app.tar.gz"
tar -xzf "$OUT/app.tar.gz" -C "$OUT"
rm "$OUT/app.tar.gz"
APP=$(find "$OUT" -maxdepth 2 -name '*.app' | head -1)
test -n "$APP" || { echo "::error::archive held no .app"; exit 1; }
[ "$APP" = "$OUT/Solunivo.app" ] || mv "$APP" "$OUT/Solunivo.app"
echo "$PROFILE build ready at $OUT/Solunivo.app"
