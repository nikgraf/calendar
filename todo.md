# Backlog (reviewed 2026-11-20)

How to read: tiers are ordered by impact, top item first within a tier.
Each item is one `todo/<slug>` PR unless it says otherwise. When an item
lands it leaves this file and `docs/decisions.md` gets a short record of
the decisions it settled — this file stays a backlog. Evidence named in an item dates from when it
was written; re-verify before starting one.

## Tier 0 — bugs

- [ ] A delete that replaces a cut or a rule change lets its exception
      deletes out ahead of itself (open since #284 and #285). Offline:
      "does not repeat" (or "this and following"), then delete the event.
      Online, the deletes the first change queued for the exceptions go
      out on their own; discarding the event's delete then leaves Google
      with the series back and those occurrences cancelled. Skipped test:
      `queueSequence.test.ts`, "the deletes a rule change queued go with
      it when a delete replaces it".
- [ ] A queued event change still holds the whole event, so an edit of
      all events replaces the series' queued change and goes to the back
      of the queue — behind a change of one occurrence made under it. The
      occurrence's own text is then overwritten by the series' older one
      (Google copies a changed text onto every exception), or an
      occurrence deleted under a new rule comes back. Needs changes that
      hold only their own fields, several per event in order. Skipped
      tests: "an occurrence keeps its own text through a later edit of
      its series", "an occurrence deleted under a new rule stays deleted
      when the series is edited again".
- [ ] An occurrence changed under a new rule that is then given up
      (discarded, or keep-theirs) keeps its change queued at a slot the
      series no longer draws, and meets a 404. Skipped test: "discarding
      a new rule takes along the change of an occurrence only it draws".
- [ ] A queued move holds no copy of its series as Google has it: what a
      pull brings for a series the move takes out of that calendar is
      left out (another device's cancelled occurrence stays on screen
      once the move lands). `queueSequence.test.ts`, `GAP.moving`.

- [ ] Let agent refs resolve zero-duration Google series occurrences
      (`packages/agent/src/resolve.ts`, `ruleProduces`; found reviewing
      #365, present before it). Slot validation uses `[start, start+1)`
      overlap, so a zero-duration event's occurrence ref returns NotFound
      on update/delete in every scope. Check exact starts in a window
      containing the slot, without relying on event duration.

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

- [ ] PR videos (designed, not built; screenshots are the proof a PR owes
      since #337) — a short recording for a PR whose change is a motion:
      `gh pr comment --attach` (`gh` ≥ 2.99.0; 10 MB on Free plans, so
      ≤ 20 s at 720p), iOS through `simctl io recordVideo` around a
      Maestro flow, the desktop through CDP `Page.startScreencast` (OS
      capture is blanked while screen privacy is on) and a pinned ffmpeg.
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
- [ ] Reminders follow-ups — subtasks/flags/tags; location alarms (the
      bridge reads one as offset 0, "At time", and any alert write keeps
      only absolute alarms, so it is replaced: `RemindersBridge.swift`'s
      DTO and `apply`); multiple editable alarms in the form (`alarms` is
      `number[]` end to end, and the Assistant changes every one since
      #315, but the picker only the first); an alert said for an undated
      reminder (a relative alarm with no due date never fires); yearly
      positional rules, several rules, day-of-month lists and
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
      of the first PR; calendar and list names as search text; the matched
      words highlighted in the rows. Measure on a phone with a large calendar: on
      Node, 5,000 events in the window, 30 endless series and 3,000 tasks
      take 55–115 ms a search, on the JS thread on iOS — FTS (or a folded
      text column) is the way out if Hermes makes typing stutter. A list left
      open moves an event from Upcoming to Past only when the next change
      re-runs the search.

## Tier 3 — AI features

- [ ] Draft thread leftovers on the desktop (the Mac's grid draws the
      thread; the iPhone's sheet covers its calendar, `docs/decisions.md`
      → AI): drafts in the month view, a slot or ⌘N editor without a
      phrase drawing its form as a draft too, to-do drafts on the grid (a
      to-do draft draws nothing yet), the "was" outline for an all-day
      draft.
- [ ] Assistant view follow-ups (the editor's two views shipped,
      `docs/decisions.md` → AI): the Search thread on steps too (it keeps
      its turns and Undo); ⌘Z / ⇧⌘Z through the steps on the Mac;
      haptics on the iPhone's
      bar and on the switch between the views (a native build);
      answering the Assistant's question by voice ("the first one", a
      model task with bench cases, not a word list).
- [ ] Served-model follow-ups (shipped in #184, `docs/decisions.md` →
      AI) — a served model now answers only search sentences and capture,
      and find a time until the Assistant's model is here; search and
      capture have no bench: measure those first. Then: no thinking and
      the strict schema on Ollama (the app sends the schema as `format`
      with only the title required and turns thinking off on neither
      route; on Assistant phrases, 2026-11-11, Gemma 4 E2B scored 40 of
      70 at 4.1 s a turn asked that way, and 59 at 0.7 s over the
      OpenAI-compatible route with every field required and
      `reasoning_effort: "none"`); the model's own context from Ollama's
      `/api/show` instead of the fixed `num_ctx`; image input for a
      served model (Gemma 4 takes images, so capture could skip OCR); the
      `ModelInfo` capability record beyond the context (modalities,
      guided JSON) once a feature reads it.
- [ ] A to-do's repeat from the Assistant — "water the plants every
      Monday" as a to-do: its result keeps only the day, time and title
      (`answerResult`, `convertQuickAddItem`), so a repeat said for it is
      lost. A to-do's repeat is a Reminders field (`ReminderFields.repeat`,
      kept only on a Reminders list), as its alerts are since #315. Probe
      first whether the current model writes one for a to-do.
- [ ] Dictated place names (two iPhone recordings, 2026-11-06,
      `docs/decisions.md` → "Calendar: editing, gestures, views",
      "Places nearby first", "A misheard place is looked for as its other
      readings"; each its own PR, in this order) — a name dictation
      mishears and the user has never been to finds nothing (MapKit's
      search reads a doubled letter, not "Cafe Meek" for Kaffemik, and
      the Assistant's model keeps the name as heard). The final reading's
      alternatives are searched too since #324, which found two more of
      the place bench's 34 synthetic cases and Kaffemik in none of its
      seven: real recordings in `places.json` (the iPhone's "Cafe Meek"
      had "Meek" among them), then the readings given to the model with
      past places and contacts, measured there; vocabulary itself reaches
      only DictationTranscriber, whose words are shown, not sent.
      MapKit's structured city/region/country fields in a native build.
- [ ] Dictation follow-ups (`docs/decisions.md` → AI, "Dictation ends
      on its words, and shows them"; measured on synthetic phrases
      only) — the pauses (900 / 1,200 ms), Reduce Background Noise and
      Mic Mode's Voice Isolation (Settings › Dictation) measured on a
      phone in real rooms (a café, a street); iOS's Mic Mode picker
      offered from the bar while it listens
      (`AVCaptureDevice.showSystemUserInterface`; Settings only shows the
      mode, since iOS offers the modes while recording, #325);
      real-room recordings in the bench, replayed through the session
      and the rule (and whether a quick recogniser that goes
      deaf one word behind the accurate one ever cuts a phrase short:
      the rule ends on the quick words then, a case constructed in
      review but never seen in the recordings, where both cures cost
      more than they saved, #322); English and German in one phrase (one
      locale per recogniser today); a person talking nearby (their
      words count: Voice Isolation measured first, then a speaker
      match learned from phrases already said); Siri as a way in (an
      App Shortcut that asks for the phrase; iOS 27's calendar schema
      where Siri AI is available, not in the EU nor in German as of
      2026-10); Parakeet TDT v3 as a recogniser arm on the Mac bench.
- [ ] The Assistant's own model, follow-ups (#307, v2 in #321) — search
      sentences and capture still need Apple's model (data and a tuned
      prompt each, in the next version's one training run); they have no
      bench yet (capture's schema leaves the time and place optional,
      and Apple's model filled no optional field on any quick-add phrase
      in the bench, 2026-11-11, unmeasured for capture). v2 reads 263 of
      305 bench cases (v1 237; the bench as it grew on 2026-11-15, #327) and
      misses, heaviest first: a place narrowed to its city or street
      (eight flows: "it's in Vienna" after a venue writes the city
      alone; the data has no such turn, only real replacements); guests
      in a later turn ("invite Sarah instead of Tom", "Jörg doch nicht",
      "invite him too", two names joined by "and") and in a long phrase;
      "a week later" counted from today, not from the draft's day; an
      end said on its own ("it ends at 11", "from 10pm to 2am"); a long
      phrase's note; a typo in the day ("tomorow", "wendsday"); "Call
      tomorrow at 4, invite Max" as a to-do; a title that keeps "event
      for". Find a time (109 of 124) titles a sentence that names no
      purpose with its own words ("Find 30 minutes") and reads "the next
      two weeks" as starting next Monday. Three conventions need a
      decision before the next labels are made, since the teacher and
      the bench differ and a model trained on the teacher fails the
      bench's case: a destination ("Trip to Vienna": the title, or the
      place), a to-do's place ("pick up the keys at reception": the
      teacher drops it, and a to-do has no place to hold it), and
      "Vacation until Friday" (the title keeps it, because no phrase
      can make a draft of several days: the answer has no end day). In
      the thread, a full name does not close an open choice of guests
      ("invite Anna", then "invite Anna Lee" leaves Anna to pick from:
      `flow-lunch-guests` fails on it for every model). Also open: a model for 6 GB iPhones (Q4_K_M, 1.2 GB loaded,
      or a smaller base); "next Friday" and deadlines ("before Friday")
      are read as the teacher read them, which wavers; notes over 200
      characters or on several lines are not shown to the model, so the
      Assistant only adds to them; a new version removes the last one's
      file at launch, so someone who had it has no Assistant until they
      tap Update (keeping it until the new one is checked costs a second
      834 MB). Not checked on a device: the iPhone's transfer across a
      quit and a network change.

- [ ] Find-a-time follow-ups — the finder keeps a whole Apple series
      busy through a series edit (its rows are read through EventKit, no
      master to read, detached occurrences not told apart): an
      EventKit-aware exclusion; timed reminders do not count as busy;
      guests' free/busy is not fetched (Google freeBusy), which is where
      "when everyone is free" would go.

- [ ] Capture follow-ups (shipped 2026-10-04, OCR-first; see
      docs/decisions.md) — keep the source text as the event's notes
      (both editors have a notes field; capture does not fill it); shared
      web URLs (the activation rule leaves them out — nothing fetches a
      page); multi-day events (capture's schema has no end day); a
      File-menu entry if ⌘V proves undiscoverable. What only Apple's
      model would gain (native image input, its own context size) is
      left: capture moves to the app's model first (above).
- [ ] Day briefing (iOS-first) — a short generated summary of the day
      (its scope: the morning, evening and week notes under Later); a
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
      small model: keep the solving deterministic (`findFreeSlots` exists).
- [ ] Invite triage (desktop) — summarize a backlog of invitations, suggest
      accept/decline (per-event RSVP exists; no inbox view).

## Later / ideas (unranked)

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
- Prefetch week±1 in the range LRU (noted when the LRU landed; today the iPhone's week view loads seven days each side, its day views one or two, the desktop two)
