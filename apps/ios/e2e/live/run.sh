#!/usr/bin/env bash
# The iOS live flows locally: the dev client is installed on a booted
# simulator and Metro is already running with the live env (see
# docs/google-sync-and-testing.md, "Live Google suite"). The sidecar
# creates this run's calendar and list and hands Maestro a one-hour
# access token as MAESTRO_LIVE_*; the flows run in this order (a
# directory's order is not deterministic); teardown always runs.
set -euo pipefail
cd "$(dirname "$0")/../.."

# The trap first: a setup that dies after creating the calendar still
# tears it down. `eval` would hide the sidecar's exit code, so capture it.
trap 'node ../../scripts/google-live-scratch.ts teardown' EXIT
vars=$(node ../../scripts/google-live-scratch.ts setup --suffix ios --export) || exit 1
eval "$vars"

# shellcheck disable=SC2086 -- an empty expansion is the point (bash 3.2 has no empty arrays)
maestro test ${SIMULATOR_UDID:+--device "$SIMULATOR_UDID"} \
  e2e/live/flows/01-live-calendar.yaml \
  e2e/live/flows/02-live-create-edit-delete.yaml \
  e2e/live/flows/03-live-conflicts.yaml \
  e2e/live/flows/04-live-tasks.yaml \
  e2e/live/flows/05-live-pull.yaml
