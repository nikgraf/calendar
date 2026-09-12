# Backlog (ranked 2026-09-10, pruned 2026-09-11)

How to read: tiers are ordered by impact, top item first within a tier.
Each item is one `todo/<slug>` PR unless it says otherwise. When an item
lands, its `[x]` entry moves to `docs/decisions.md` with the decisions it
settled — this file stays a backlog. File:line evidence is from the
2026-09-10 audit; re-verify before starting an item. The 2026-09-11
sweep (`todo/backlog-tiers`) closed every item of the former tiers 1–6
except the two below; their entries are in `docs/decisions.md` under
"Backlog sweep (2026-09-11)".

## Tier 1 — CI and distribution

- [ ] PR videos (designed, not built) — every PR with a visible change
      attaches a short recording. `gh` ≥ 2.99.0 (2026-09-01; local is
      2.97.0, `brew upgrade gh`) adds `--attach` to `gh pr create/edit/
comment` for inline-playable video: 10 MB on Free plans, 100 MB paid
      — design for 10 MB (≤ 20 s clips, 720p wide, `-crf 28` ≈ 1–3 MB).
      Tooling: `pnpm record ios <flow>` wraps `maestro test` in
      `xcrun simctl io $UDID recordVideo --codec h264 --mask black`
      (`kill -INT` finalizes the file); `pnpm record desktop "<it name>"`
      runs one spec by name with CDP `Page.startScreencast` in
      `apps/desktop/e2e/harness.ts` — OS-level capture is blanked by
      `setContentProtection`, so the compositor path is the only one that
      works; `ws.onmessage` (`harness.ts:181`) currently drops id-less
      events, so add an event map + `Page.screencastFrameAck` — frames →
      `ffmpeg -framerate 15 … libx264`. CI: a `record` PR label (same
      trigger shape as the `testflight` label, `ios.yml:227-234`) records
      flows tagged `record` inside the existing `e2e`/`ios-e2e` jobs and
      posts `gh pr comment --attach` with the comment-upsert pattern from
      `ios.yml:207-221`; ffmpeg is not on the runner images (pinned static
      binary). PR template gains a "video attached / n.a." checkbox. Not
      possible: REST/GraphQL upload; inline playback from an Actions
      artifact or a private-repo release asset.
- [ ] Real app icons (macOS .icns / Assets.car, iOS icon set) — nothing
      exists: `forge.config.cjs` has no `icon`, `app.json` no `expo.icon`;
      every artifact ships the stock Electron / Expo icon. Logo design
      notes first (see Later).

## Tier 2 — features (near-term, well-scoped)

- [ ] Tasks in month view — cheapest item in the file: both month views
      already have the data in scope and never receive it
      (`CalendarApp.tsx:247-257`, `App.tsx:202-211`); dots or counts per day.
- [ ] Manage conflicts with a choice — today 412 means server wins: the op
      is dropped and `notice:conflict` broadcast (`applyOp.ts:315`), and the
      payload — the user's version — is deleted before anyone could offer
      it. Park it, make the notice name the event, offer keep-mine / take-
      theirs.
- [ ] Events: the 12-months-back floor — `INITIAL_WINDOW_MS`
      (`engine.ts:42`) is `timeMin` on every full pass and `deleteStale`
      prunes older rows; browsing further back shows nothing. On-demand
      backfill or a larger floor.
- [ ] Show contact birthdays — Google exposes a read-only Birthdays
      calendar (`addressbook#contacts@group.v.calendar.google.com`) through
      the normal calendarList, and `syncCalendarList` has no allow-list, so
      it probably syncs already. Verify annual recurrence through
      `expandRecurringEvent` and `eventType: 'birthday'`, make the editor
      read-only for it, 🎂 chip style, toggleable calendar. Later: merge
      device-contact birthdays.
- [ ] Tasks: subtask hierarchy — `parent`/`position` are decoded
      (`apiTypes.ts:139-140`) and dropped by `mapGcalTask`; `TaskRecord` has
      no such fields; `tasksClient.ts` has no `move`. Render indentation,
      keep ordering via `tasks.move`.
- [ ] Convert a Reminder ↔ Google Task — create in target + delete in
      source with a "these fields will be lost" confirmation; today
      `moveToListId` is Reminders-internal (`UnsupportedForProviderError`
      for Google, `mutations.ts:223-240`).
- [ ] Reminders follow-ups — undated reminders are mirrored but filtered
      out at read (`repos.ts:737`, needs a list view); quick-add/⌘K creating
      reminders (`QUICK_ADD_JSON_SCHEMA` is events-only); subtasks/flags/
      tags; location alarms; multiple editable alarms (`alarms` is already
      `number[]` end to end); by-day/positional recurrence editing (round-
      trips as `{unsupported:true}`); timed reminders in the time grid;
      creating/deleting Reminders lists (`REMINDERS_METHODS` has neither).

## Tier 3 — AI features

Scope unchanged and all still open with zero code; the on-device-only
decision and platform notes live in `docs/decisions.md`.

- [ ] Capture from text or photo — paste an email (desktop) or share a
      screenshot/poster (iOS share sheet) → extracted event(s). Needs an
      image input on the `LanguageModel` seam (`packages/ai`, text-only
      today) and an iOS share-extension target.
- [ ] Day briefing (iOS-first) — a short generated summary of the day; a
      widget or Live Activity candidate once it earns its place.
- [ ] Ask your calendar — start with SQLite FTS5 (no virtual table exists
      yet), which honestly covers most recall; on-device embeddings only if
      fuzzy recall proves necessary.
- [ ] Week planning / rescheduling assistant (desktop) — "make room for 3h
      of deep work" proposes a _diff_ of moves to approve, executed through
      the op queue so it stays inspectable and undoable. Weakest fit for a
      3B model: keep the solving deterministic (`findFreeSlots` exists).
- [ ] Invite triage (desktop) — summarize a backlog of invitations, suggest
      accept/decline (per-event RSVP exists; no inbox view).

## Later / ideas (unranked)

- Logo design (see notes todo with most important take aways)
- Research Siri Calendar integration (no App Intents anywhere yet)
  - Ask ChatGPT (deepresearch) about flows that exist
- Morning briefing made with AI
  - Weather during the day and what to wear (also take other locations into account and especially weather changes)
  - Get an overview over the most important meetings
  - AI can understand how busy the day will be and judge what to do with reminders e.g. move to another day
    - allow to choose if you want an easy or focus day to help you guide
    - allow to go through reminders yourself (easyly adept the changes) and allow to prioretize what's important and what not based
- Evening briefling
  - Caputure one to two sentenced about the day
    - where to store it? encrypted in google or apple notes?
  - Caputure one to two sentenced about the day (what was good, what did you achieve)
  - Caputure one to two sentenced about the day (what was bad)
- Week briefing
  - What was accomplished
- Personal Dashboard: Pull in data from manu sources
  - Strava
  - Weather (also show on the day?)
  - Food tracking (nutrition data + macros)
  - Garmin data e.g. body battery
  - Birthdays
    - Custom reminders for birthdays
      - standard per birthday e.g. 1 week before, 1 day before, on the day
      - change and overwrite it per person
  - Different views:
    - Business view(s) with certain selected calendar
      - What can other people see e.g. impersonation of a colleage
    - Personal dashboard view shows everything
      - allow to block time
- API for OpenClaw/Hermes to interact with (CalDir inspired https://caldir.org/)
- Server mode that doesn't run the GUI?
- Habit builder (setup as remiders?)
- Linux support (AI support?)
- Android support (what does Android offer as local AI?)
- Integration with Microsoft Calendar (more relevant for Windows)
- Windows support (Copilot support?)
- Special sync
  - same event in multiple calendar (how do they get identified?)
    - special feature: automatically sync those e.g. meetup event gets synced to family calendar
    - special feature: add in one calendar as normal even, but show in others as blocked or only share certain information
- Prefetch week±1 in the range LRU (noted when the LRU landed)
