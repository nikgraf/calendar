# Backlog (ranked 2026-09-10, pruned 2026-09-11, reviewed 2026-10-02)

How to read: tiers are ordered by impact, top item first within a tier.
Each item is one `todo/<slug>` PR unless it says otherwise. When an item
lands it leaves this file and `docs/decisions.md` gets a short record of
the decisions it settled — this file stays a backlog. File:line evidence is from the
2026-09-10 audit; re-verify before starting an item. The 2026-09-11
sweep (`todo/backlog-tiers`) closed every item of the former tiers 1–6
except the two below; their entries are in `docs/decisions.md` under
"Backlog sweep (2026-09-11)".

## Tier 0 — bugs

The 2026-10-02 review's findings are closed in `docs/decisions.md`
(Review fixes, #110–#142).

- [ ] File an Expo issue (worked around here; not filed yet): under SDK
      58's scene life cycle a background launch that connects no scene
      starts no React Native, so expo-task-manager tasks
      (expo-background-task, background fetch) never run after the app
      was terminated. Code path: `ExpoAppSceneDelegate.swift:66`,
      `EXTaskService.m` `_loadAppWithId` (its `react-native-experience`
      app loader is Expo Go's, and it is consulted only with an app URL,
      which a bare app never stores). Our workaround to point at:
      `apps/ios/modules/solunivo-background-launch`.
- [ ] File an Expo issue (worked around here; not filed yet): @expo/ui
      58's community `MenuView` sizes its host by Yoga and bounds the
      trigger by it, taking the trigger's own margin off the trigger's
      width, so the content is clipped (the view menu's "▾"; SDK 57's
      `matchContents` host ignored the margin instead).

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
- [ ] Live suite follow-ups (review of #88/#90, 2026-09-26; the findings
      themselves shipped in `todo/review-findings`, the sweep's account
      check and the split test's occurrences in `todo/live-sweep-guard`).
      The people test passes on an empty address book and the RSVP test
      only exercises the organizer guard — decide whether a known contact
      fixture and a second live account for guest-side RSVPs are worth
      their upkeep. A carried text's queued instance ops keep their
      payload: rewrite it on restore if the pull-converges gap ever shows
      up.

## Tier 2 — features (near-term, well-scoped)

- [ ] Per-calendar "keep only N years" switch — only should storage ever
      matter (2026-10-04: 303 events in 380 KB; the RDATE and COUNT
      follow-ups shipped, see `docs/decisions.md`). Google calendars only
      (Apple events are never stored). A `timeMin` token cannot be widened
      later, so turning the switch on/off or changing N drops the
      calendar's `events:<id>` `sync_state` row and re-lists; the windowed
      full list plus `deleteStale` removes the old rows. Events still age
      past the window afterwards, so a periodic local prune is needed too —
      keeping pending rows, endless masters (`recurrence_end_utc IS NULL`)
      and masters still in the window together with their overrides. A
      `calendars` column left out of `upsertMany`'s `ON CONFLICT`, like
      `is_visible`; a field on `GoogleCalendarPref` in `SettingsDocument`
      (the import's visibility-specific parking in `importedVisibility.ts`
      widens with it); the "History complete" label says what is kept.
- [ ] Calendar mirrors follow-ups — a merged "busy day" block for all-day
      availability is keyed by its dates, so a window edge sliding past
      one leaves a stale copy behind (harmless, past); a copy someone with
      write access edited is not reverted until its source changes; the
      Apple bridge does not read availability, so "marked free" is Google
      only; definitions could sync through iCloud key-value storage
      instead of the settings file (a new entitlement in every build).
- [ ] Reminders follow-ups — subtasks/flags/tags; location alarms;
      multiple editable alarms (`alarms` is already `number[]` end to
      end); yearly positional rules, several rules, day-of-month lists and
      a monthly rule on a plain weekday without an ordinal still
      round-trip as `{unsupported:true}` (weekly by-day and monthly
      ordinals ship since 2026-09-20); creating/deleting Reminders lists
      (`REMINDERS_METHODS` has neither); moving an undated task to
      another list asks for a due day first (`moveTask` takes a
      `TaskDraft`, whose `dueDate` is required; only Reminders →
      Reminders re-homes in place and keeps it undated).

- [ ] Task drag follow-up — shrink `WEEK_SWIPE_BUFFER` once day-by-day
      paging has proven itself on device (seven columns each side is
      more than a flick reveals).

- [ ] Agent gateway follow-ups (shipped 2026-10-01, docs/agent-gateway.md)
      — a login item and a menu-bar item, so agents work without anyone
      having opened the app (today: it keeps running after the last
      window closes, and the relay launches it with `--background`, Dock
      icon included); an "Install `solunivo` on PATH" button (the wrapper
      already resolves symlinks); undo for an agent's write from the
      activity list; grants on calendars hidden in the app (range reads
      filter on `is_visible`, so today hidden = `none`); an Apple event
      marked free still counts as busy in free/busy and slots (Google's
      are skipped since #197; the Apple bridge does not read EventKit's
      `availability`, one fix with the mirrors entry; the app's own
      find-a-time counts them the same way);
      a Swift relay in place of the TS one so the RunAsNode fuse can be
      flipped (`@electron/fuses`); moves and conversions as tools;
      MCP `subscriptions/listen` fed by the invalidation bus; access from
      another machine (needs real transport auth — out of scope so far).
      Manual checks still open: a real Hermes/OpenClaw session, the relay
      under the notarized build from `/Applications`, relay auto-launch,
      a real guest invitation at "ask".

- [ ] Search follow-ups (shipped 2026-10-09, `docs/decisions.md`) — a
      `search` tool for the agent gateway (a read grant; a hidden calendar or
      list must answer nothing, as the range reads do), deliberately left out
      of the first PR; recall beyond the two-year window (Tier 3, "Ask your
      calendar"); calendar and list names as search text; the matched words
      highlighted in the rows. Measure on a phone with a large calendar: on
      Node, 5,000 events in the window, 30 endless series and 3,000 tasks
      take 55–115 ms a search, on the JS thread on iOS — FTS (or a folded
      text column) is the way out if Hermes makes typing stutter. A list left
      open moves an event from Upcoming to Past only when the next change
      re-runs the search.

## Tier 3 — AI features

AI redesign (agreed 2026-10-11, one PR each, in this order; the
grounding PR that opened it, #182, the desktop draft thread (#183),
the served model (#184) and slot proposals (#185) are in
`docs/decisions.md` → AI, with the iOS thread in the sheet (#187) and on the calendar (#188); search filters (#186) under Search):

- [ ] Draft thread leftovers on the desktop (both platforms draw the
      thread now, `docs/decisions.md` → AI): drafts in the month view, a
      slot or ⌘N editor without a phrase drawing its form as a draft too,
      to-do drafts on the grid (a to-do draft draws nothing yet).
- [ ] Served-model follow-ups (shipped in #184,
      `docs/decisions.md` → AI) — the model's own context from Ollama's
      `/api/show` instead of the fixed `num_ctx`; image input for a served
      model (Gemma 4 takes images, so capture could skip OCR); the
      `ModelInfo` capability record beyond the context (modalities, guided
      JSON) once a feature reads it.
- [ ] Model bench follow-ups (the bench, 2026-10-25, `docs/decisions.md`
      → AI; each its own PR, the bench re-run in the PR body) — a bare
      "make it 8" and the dictated "eight" are not read as a time
      (SpeechAnalyzer writes small numbers as words); a German change
      taken as a title ("lieber Mittwoch"); the small-hours reading of a
      bare 1–6 (open since #248); a to-do's alarms from "remind me …
      before" (an event's notifications are read since 2026-10-26).
- [ ] Dictated quick-add follow-ups (two iPhone recordings, 2026-11-06;
      the place lookup's share, the spoken command and the place a first
      phrase leads into shipped, `docs/decisions.md` → "Calendar: editing,
      gestures, views", "Places nearby first", and → AI, "A spoken command
      is not the title", "The place a phrase leads into"; each its own PR,
      in this order) — a turn
      that names only a city or district replaces the place instead of
      narrowing it ("it's in Vienna" after "Cafe Meek" sets "Vienna" or
      changes nothing, with the right transcript too), and a bare "with
      Stefan" lands in the location; a name dictation mishears and the
      user has never been to finds nothing (MapKit's search reads a
      doubled letter, not "Cafe Meek" for Kaffemik, and Apple's model
      cannot respell it) — recognizer vocabulary from contacts and past
      places, which needs an own speech module on iOS
      (`@react-native-ai/apple` takes audio and a locale); bench cases
      for all of it: none leans on the turn before, none asks MapKit, and
      the Mac's model titles a phrase the iPhone's echoes; a first
      phrase's name that no kind of place goes with is not read ("at
      Luigi's", "… um 10 im Figlmüller", "Dinner in Vienna": written
      like "at Thanksgiving", "im Regen" and "in German", and Apple's
      model drops and names them all alike) — a possible place the
      lookup confirms (a past place, or a nearby hit called exactly
      that) could; nor a place before the company ("at Loos Bar with
      Jo"), one with its when after it in German ("im Café Prückel am
      Abend": the trim leaves "am Abend") or a name with a weekday in it
      without the model ("Ruby Tuesday"), and the Mac's model cuts a
      title at its when, so what follows and is no place is lost
      ("Laufen morgen um 7 im Regen" is "Laufen").
- [ ] Gemma 4 on iOS — opt-in download via llama.rn (JSON schema →
      grammar maps onto `generateJson`), load on demand, unload on
      background; only if the bench shows the model is the bottleneck.

- [ ] Find-a-time follow-ups — the finder keeps a whole Apple series
      busy through a series edit (its rows are read through EventKit, no
      master to read, detached occurrences not told apart): an
      EventKit-aware exclusion; timed reminders do not count as busy;
      guests' free/busy is not fetched (Google freeBusy), which is where
      "when everyone is free" would go.

Scope unchanged and all still open with zero code; the on-device-only
decision and platform notes live in `docs/decisions.md`.

- [ ] Capture follow-ups (shipped 2026-10-04, OCR-first; see
      docs/decisions.md) — **native image input on OS 27**: Foundation
      Models takes an image directly there (`Transcript.ImageAttachment`,
      `Attachment(imageURL:)`, the `vision` capability), which reads a
      stylised poster better than OCR text does. Shape: an optional
      `images` field plus a capability check on `LanguageModel`, one more
      branch in `parseCapture` (OCR stays the OS 26 path through the
      `TextRecognizer` seam, nothing above changes), a helper method that
      builds the attachment, and own Swift on iOS since
      `@react-native-ai/apple` 0.12 is text-only. Also: keep the source
      text as the event's notes (both editors have a notes field;
      capture does not fill it); shared web URLs
      (the activation rule leaves them out — nothing fetches a page);
      multi-day events (the editor clamps an end to its start day); a
      File-menu entry if ⌘V proves undiscoverable; token counting via
      `SystemLanguageModel.contextSize` (26.4+) in place of the 6000-char
      cap.
- [ ] Day briefing (iOS-first) — a short generated summary of the day; a
      widget or Live Activity candidate once it earns its place.
- [ ] Ask your calendar — plain search shipped (2026-10-09, see
      `docs/decisions.md` → Search): every-word matching over what the views
      show, events two years either side of today. Recall beyond that window
      is this item: SQLite FTS5 over the stored events and tasks (no virtual
      table exists yet), which honestly covers most recall; on-device
      embeddings only if fuzzy recall proves necessary. Apple Calendar events
      are read through, so they keep a window (EventKit answers only bounded
      queries).
- [ ] Week planning / rescheduling assistant (desktop) — "make room for 3h
      of deep work" proposes a _diff_ of moves to approve, executed through
      the op queue so it stays inspectable and undoable. Weakest fit for a
      3B model: keep the solving deterministic (`findFreeSlots` exists).
- [ ] Invite triage (desktop) — summarize a backlog of invitations, suggest
      accept/decline (per-event RSVP exists; no inbox view).

## Later / ideas (unranked)

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
  - Birthdays (shown since 2026-09-12; per-person reminders since 2026-10-04, a time per reminder since 2026-10-24)
  - Different views:
    - Business view(s) with certain selected calendar
      - What can other people see e.g. impersonation of a colleage
    - Personal dashboard view shows everything
      - allow to block time
- Habit builder (setup as remiders?)
- Linux support (AI support?)
- Android support (what does Android offer as local AI?)
- Integration with Microsoft Calendar (more relevant for Windows)
- Native JMAP calendars (CalDAV and Outlook accounts work today through
  Apple Calendar; the website's roadmap lists this, Microsoft and the
  three platforms here)
- Windows support (Copilot support?)
- Special sync
  - same event in multiple calendar (how do they get identified?)
    - special feature: automatically sync those e.g. meetup event gets synced to family calendar
    - special feature: add in one calendar as normal even, but show in others as blocked or only share certain information
- Prefetch week±1 in the range LRU (noted when the LRU landed)
