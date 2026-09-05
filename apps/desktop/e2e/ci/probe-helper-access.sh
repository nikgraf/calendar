#!/usr/bin/env bash
# Hard gate for the real-Reminders desktop job: the helper must report
# fullAccess without a prompt. Anything else fails the job — the seeded
# TCC grant (grant-reminders-tcc.sh) is unsupported and is expected to
# break loudly on some future runner image rather than let the suite go
# green while testing nothing. On failure, print what tccd recorded:
# the row it added for the real requesting identity and its own log
# lines are what the next fix needs.
set -euo pipefail

HELPER="${1:?path to solunivo-model-helper}"
DB="$HOME/Library/Application Support/com.apple.TCC/TCC.db"
RESPONSE=$( (printf '{"id":1,"method":"reminders.status","params":{}}\n'; sleep 2) \
  | "$HELPER" 2>/dev/null | head -1 || true)
echo "helper: $RESPONSE"
STATUS=$(printf '%s' "$RESPONSE" | jq -r '.result.authorization // empty' 2>/dev/null || true)
if [ "$STATUS" != "fullAccess" ]; then
  echo "--- TCC rows after the check (a new row names the identity tccd used)"
  sudo sqlite3 "$DB" "SELECT service, client, client_type, auth_value, auth_reason FROM access
    WHERE service LIKE '%Reminders%' OR last_modified > strftime('%s','now') - 600" || true
  echo "--- tccd log (last 5 minutes, Reminders)"
  sudo log show --last 5m --predicate 'subsystem == "com.apple.TCC"' 2>/dev/null \
    | grep -a "kTCCServiceReminders\|solunivo-model-helper\|AUTHREQ_RESULT\|AUTHREQ_PROMPT" \
    | grep -av "AddressBook\|contactsd\|com.apple.mds" | tail -60 || true
  echo "::error::helper reports '${STATUS:-no answer}', expected fullAccess — the TCC seed did not take on this image"
  exit 1
fi
echo "Reminders access: fullAccess"
