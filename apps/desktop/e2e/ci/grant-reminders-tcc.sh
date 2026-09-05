#!/usr/bin/env bash
# Pre-grant Reminders access on a headless macOS runner by seeding the
# per-user TCC database. Not an Apple-supported interface: the column set
# of `access` drifts between macOS versions (14 added pid, pid_version,
# boot_uuid, last_reminded), so the INSERT names its columns and the
# schema is printed for the day it breaks. Three client identities are
# seeded because TCC may attribute the helper's request to the helper's
# embedded bundle id, to its path, or to the responsible parent process
# (Electron in a dev checkout). probe-helper-access.sh then asserts the
# grant is effective — a red job, never a silent skip.
set -euo pipefail

HELPER="${1:?path to solunivo-model-helper}"
HELPER=$(cd "$(dirname "$HELPER")" && pwd)/$(basename "$HELPER")
DB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"

echo "--- access table schema on $(sw_vers -productVersion)"
sudo sqlite3 "$DB" ".schema access"

NOW=$(date +%s)
grant() {
  sudo sqlite3 "$DB" "INSERT OR REPLACE INTO access
    (service, client, client_type, auth_value, auth_reason, auth_version,
     csreq, policy_id, indirect_object_identifier_type,
     indirect_object_identifier, indirect_object_code_identity, flags,
     last_modified)
    VALUES ('kTCCServiceReminders', '$1', $2, 2, 4, 1,
            NULL, NULL, 0, 'UNUSED', NULL, 0, $NOW)"
  echo "granted kTCCServiceReminders to $1 (client_type $2)"
}

grant "com.solunivo.desktop.helper" 0
grant "$HELPER" 1
grant "com.github.Electron" 0

sudo killall tccd 2>/dev/null || true
echo "--- kTCCServiceReminders rows"
sudo sqlite3 "$DB" "SELECT client, client_type, auth_value FROM access WHERE service = 'kTCCServiceReminders'"
