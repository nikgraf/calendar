#!/usr/bin/env bash
# The iOS live flows locally: the dev client is installed on a booted
# simulator and Metro is already running with the live env (see
# docs/google-sync-and-testing.md, "Live Google suite"). The sidecar
# creates this run's calendar and list and hands Maestro a one-hour
# access token as MAESTRO_LIVE_*; the flows run in this order (a
# directory's order is not deterministic); teardown always runs.
set -euo pipefail
cd "$(dirname "$0")/../.."

eval "$(node ../../scripts/google-live-scratch.ts setup --suffix ios --export)"
trap 'node ../../scripts/google-live-scratch.ts teardown' EXIT

device=()
if [ -n "${SIMULATOR_UDID:-}" ]; then
  device=(--device "$SIMULATOR_UDID")
fi

maestro test "${device[@]}" \
  e2e/live/flows/01-live-calendar.yaml \
  e2e/live/flows/02-live-create-edit-delete.yaml \
  e2e/live/flows/03-live-resize.yaml \
  e2e/live/flows/04-live-conflicts.yaml \
  e2e/live/flows/05-live-tasks.yaml \
  e2e/live/flows/06-live-pull.yaml
