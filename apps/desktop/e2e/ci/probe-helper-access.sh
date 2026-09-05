#!/usr/bin/env bash
# Hard gate for the real-Reminders desktop job: the helper must report
# fullAccess without a prompt. Anything else fails the job — the seeded
# TCC grant (grant-reminders-tcc.sh) is unsupported and is expected to
# break loudly on some future runner image rather than let the suite go
# green while testing nothing.
set -euo pipefail

HELPER="${1:?path to solunivo-model-helper}"
RESPONSE=$( (printf '{"id":1,"method":"reminders.status","params":{}}\n'; sleep 2) \
  | "$HELPER" 2>/dev/null | head -1 || true)
echo "helper: $RESPONSE"
STATUS=$(printf '%s' "$RESPONSE" | jq -r '.result.authorization // empty' 2>/dev/null || true)
if [ "$STATUS" != "fullAccess" ]; then
  echo "::error::helper reports '${STATUS:-no answer}', expected fullAccess — the TCC seed did not take on this image"
  exit 1
fi
echo "Reminders access: fullAccess"
