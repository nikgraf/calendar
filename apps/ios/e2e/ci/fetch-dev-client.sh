#!/usr/bin/env bash
# Fetch the EAS development-simulator build for a native fingerprint into
# build/devclient/, requesting one first when this fingerprint has none.
# When the cloud build quota is exhausted, compile the same dev client on
# the macOS runner. The Actions cache keeps either result by fingerprint.
set -euo pipefail

FP="${1:?native fingerprint hash}"
OUT="build/devclient"
PROFILE="development-simulator"
REQUEST_LOG=$(mktemp)
trap 'rm -f "$REQUEST_LOG"' EXIT

list() {
  pnpm exec eas build:list --platform ios --build-profile "$PROFILE" \
    --fingerprint-hash "$FP" --status "$1" --limit 1 --json --non-interactive
}

BUILD_ID=$(list finished | jq -r '.[0].id // empty')
if [ -z "$BUILD_ID" ]; then
  # Two pushes with the same new fingerprint must not queue two builds.
  for status in in-progress in-queue new; do
    BUILD_ID=$(list "$status" | jq -r '.[0].id // empty')
    [ -n "$BUILD_ID" ] && break
  done
  if [ -n "$BUILD_ID" ]; then
    echo "Waiting for in-flight build $BUILD_ID (fingerprint $FP)"
    while :; do
      STATUS=$(pnpm exec eas build:view "$BUILD_ID" --json 2>/dev/null | jq -r '.status // empty')
      case "$STATUS" in
        FINISHED) break ;;
        ERRORED|CANCELED|PENDING_CANCEL) echo "::error::build $BUILD_ID ended as $STATUS"; exit 1 ;;
        *) sleep 30 ;;
      esac
    done
  else
    echo "No $PROFILE build for fingerprint $FP — requesting one on EAS"
    if BUILD_JSON=$(pnpm exec eas build --platform ios --profile "$PROFILE" \
      --non-interactive --json 2>"$REQUEST_LOG"); then
      cat "$REQUEST_LOG" >&2
      BUILD_ID=$(printf '%s' "$BUILD_JSON" | jq -r '.[0].id // .id // empty')
    else
      cat "$REQUEST_LOG" >&2
      # Do not hide authentication, network, or cloud compilation failures.
      grep -Fq 'has used its iOS builds from the Free plan this month' "$REQUEST_LOG" || exit 1
      echo "::warning::EAS iOS build quota exhausted — building the simulator client on this runner"
      rm -rf "$OUT"
      pnpm exec expo run:ios --configuration Debug --device generic --no-bundler --output "$OUT"
      test -d "$OUT/Solunivo.app" || { echo "::error::local build produced no Solunivo.app"; exit 1; }
      echo "Dev client ready at $OUT/Solunivo.app"
      exit 0
    fi
    test -n "$BUILD_ID" || { echo "::error::eas build returned no build id"; exit 1; }
  fi
fi

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
echo "Dev client ready at $OUT/Solunivo.app"
