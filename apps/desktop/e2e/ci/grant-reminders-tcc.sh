#!/usr/bin/env bash
# Pre-grant Reminders access on a headless macOS runner by seeding the
# per-user TCC database. Not an Apple-supported interface: the column set
# of `access` drifts between macOS versions (14 added pid, pid_version,
# boot_uuid, last_reminded), so the INSERT names its columns and the
# schema is printed for the day it breaks.
#
# TCC keys a decision on the requesting client's identity, and for a
# process launched from a runner shell that identity is not obvious: it
# may be the helper's code-signing identifier or its path, the helper's
# embedded bundle id, the responsible process further up the launchd
# chain (the runner's provisioner / Runner.Worker), or Electron in a dev
# checkout. Every plausible identity is seeded; bundle-id rows carry the
# helper's compiled designated requirement (csreq) since newer tccd
# ignores unverifiable rows. probe-helper-access.sh then asserts the
# grant is effective — a red job, never a silent skip.
set -euo pipefail

HELPER="${1:?path to solunivo-model-helper}"
# The real path: SwiftPM's .build/release is a symlink, and tccd records
# the resolved binary_path (.build/arm64-apple-macosx/release/…).
HELPER=$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$HELPER")
DB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"

echo "--- access table schema on $(sw_vers -productVersion)"
sudo sqlite3 "$DB" ".schema access"

# The helper's designated requirement, compiled to the blob TCC stores.
CSREQ_HEX=""
REQ=$(codesign -d -r- "$HELPER" 2>&1 | sed -n 's/^# designated => //p' || true)
if [ -n "$REQ" ]; then
  TMP=$(mktemp)
  if csreq -r="$REQ" -b "$TMP" 2>/dev/null; then
    CSREQ_HEX=$(xxd -p "$TMP" | tr -d '\n')
  fi
  rm -f "$TMP"
fi
echo "helper requirement: ${REQ:-none} (csreq ${#CSREQ_HEX} hex chars)"
SIGNING_ID=$(codesign -dv "$HELPER" 2>&1 | sed -n 's/^Identifier=//p' || true)

NOW=$(date +%s)
grant() {
  local csreq="NULL"
  if [ "$3" = "csreq" ] && [ -n "$CSREQ_HEX" ]; then csreq="X'$CSREQ_HEX'"; fi
  sudo sqlite3 "$DB" "INSERT OR REPLACE INTO access
    (service, client, client_type, auth_value, auth_reason, auth_version,
     csreq, policy_id, indirect_object_identifier_type,
     indirect_object_identifier, indirect_object_code_identity, flags,
     last_modified)
    VALUES ('kTCCServiceReminders', '$1', $2, 2, 4, 1,
            $csreq, NULL, 0, 'UNUSED', NULL, 0, $NOW)"
  echo "granted kTCCServiceReminders to $1 (client_type $2, csreq ${3})"
}

grant "com.solunivo.desktop.helper" 0 csreq
[ -n "$SIGNING_ID" ] && grant "$SIGNING_ID" 0 csreq
grant "$HELPER" 1 csreq
grant "com.github.Electron" 0 none
# The runner's responsible process. tccd's attribution on a GitHub
# macos-26 image (from its own log): responsible={identifier=a.out,
# responsible_path=/opt/hca/hosted-compute-agent}, accessing=the helper —
# and a decision for a bare accessor is keyed on the responsible process.
# Older images used the provisioner paths; all of them are seeded.
grant "a.out" 0 none
for RESPONSIBLE in \
  /opt/hca/hosted-compute-agent \
  /opt/off/opt/runner/provisioner/provisioner \
  /usr/local/opt/runner/provisioner/provisioner \
  "$HOME/actions-runner/bin/Runner.Worker" \
  "$HOME/actions-runner/bin/Runner.Listener"; do
  grant "$RESPONSIBLE" 1 none
done

sudo killall tccd 2>/dev/null || true
echo "--- kTCCServiceReminders rows"
sudo sqlite3 "$DB" "SELECT client, client_type, auth_value, length(csreq) FROM access WHERE service = 'kTCCServiceReminders'"
