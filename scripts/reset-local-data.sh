#!/usr/bin/env bash
# Wipe every piece of Solunivo state on this machine: the desktop app's
# database, tokens, logs and settings (dev and packaged builds), the
# safeStorage keys in the login keychain, Squirrel update caches, stray e2e
# profiles, and the iOS app on every booted simulator. Run it after the
# schema baseline (2026-09-15) or whenever a clean first launch is wanted:
#
#   pnpm reset:local
#
# Not touched: TCC grants (Contacts/Reminders permissions), your Apple
# Reminders and Contacts data, and apps/desktop/google-oauth.local.json.
# Physical iOS devices: delete the app by hand (same bundle id for the dev
# client and TestFlight, so one delete covers both).
set -euo pipefail

remove() {
  if [ -e "$1" ]; then
    echo "removing $1"
    rm -rf "$1"
  fi
}

# Desktop — Electron userData (calendar.db, secure/tokens.json, logs/,
# settings.json, Chromium caches). The dev build is named after the
# package (@calendar/desktop); the packaged app after the packager name.
remove "$HOME/Library/Application Support/@calendar/desktop"
remove "$HOME/Library/Application Support/Solunivo"

# The safeStorage master key for tokens.json lives in the login keychain
# under "<app name> Safe Storage"; without it a leftover blob is unreadable
# anyway, but drop it so the next launch starts from nothing.
for service in "@calendar/desktop Safe Storage" "Solunivo Safe Storage"; do
  if security find-generic-password -s "$service" >/dev/null 2>&1; then
    echo "removing keychain item: $service"
    security delete-generic-password -s "$service" >/dev/null
  fi
done

# Squirrel.Mac auto-update staging and defaults, current and pre-rename ids.
for id in com.solunivo.desktop com.nikgraf.calendar; do
  remove "$HOME/Library/Caches/$id"
  remove "$HOME/Library/Caches/$id.ShipIt"
  remove "$HOME/Library/Preferences/$id.plist"
done

# Desktop e2e profiles a crashed run may have left behind.
for dir in "${TMPDIR:-/tmp}"/calendar-e2e-*; do
  remove "$dir"
done

# iOS — the app container (Documents/calendar.db, crash log, expo-updates
# state) goes with the app. Keychain items on a simulator can outlive an
# uninstall; they are keyed by account id and overwritten at the next
# sign-in, so they are harmless.
if command -v xcrun >/dev/null 2>&1; then
  booted=$(xcrun simctl list devices booted -j 2>/dev/null \
    | python3 -c 'import json,sys; print("\n".join(d["udid"] for v in json.load(sys.stdin)["devices"].values() for d in v))' \
    || true)
  for udid in $booted; do
    if xcrun simctl get_app_container "$udid" com.solunivo.app >/dev/null 2>&1; then
      echo "uninstalling com.solunivo.app from simulator $udid"
      xcrun simctl uninstall "$udid" com.solunivo.app
    fi
  done
  [ -n "$booted" ] || echo "no booted simulator; boot one first if the iOS app should be reset too"
fi

echo "done — a physical iOS device is reset by deleting the app"
