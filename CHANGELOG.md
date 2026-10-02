# Changelog

Versions are bumped together across `package.json` files when a release is
worth a number (see docs/distribution.md → Versions). Entries summarize;
the design decisions behind them live in `docs/decisions.md`.

## Unreleased

- Calendar mirrors (Settings → Mirrors): copy events from your calendars
  and lists into one calendar you share, reduced to what you choose —
  just "Busy", the title and place, or the full details. Runs on the Mac
  and the iPhone; a mirror reaches another device through the settings
  file. Undated tasks now show on today, and a task completed late stays
  on the day it was completed. Sign-in asks for one more Google
  permission (creating secondary calendars) so the editor can make the
  destination calendar.

## 0.1.0 — 2026-09-10

First numbered version. Everything up to here: Google Calendar day/week/
month with drag editing and recurring series, Google Tasks and Apple
Reminders in the all-day lane, invitees with device + Google contact
suggestions, on-device quick add / find-a-time / dictation, and the
sync-path fixes from the 2026-09 audit.
