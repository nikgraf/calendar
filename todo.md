# Backlog (ranked 2026-09-10)

How to read: tiers are ordered by impact, top item first within a tier.
Each item is one `todo/<slug>` PR unless it says otherwise. When an item
lands, its `[x]` entry moves to `docs/decisions.md` with the decisions it
settled — this file stays a backlog. File:line evidence is from the
2026-09-10 audit; re-verify before starting an item.

## Tier 1 — correctness (data loss or wrong data, verified in code)

- [ ] Silent drop of edits on permanent 4xx — `applyOp.ts:319-323` answers
      any non-409 4xx with `'done'`: the op is deleted, no notice, no log.
      `markFailed` writes the constant `'transient failure'`
      (`mutations.ts:200-205`) so the unsynced-changes panel can never show
      a cause, and `processPendingOps` ends in `catchCause(() => Effect.void)`
      (`:210`). Persist the real cause in `pending_ops.last_error`, broadcast
      a `notice:dropped` the way the 412 path broadcasts `notice:conflict`,
      log in the catch. Also: `InsufficientScopeError` calls
      `setTasksEnabled(false)` for any op kind (`applyOp.ts:328-332`).
- [ ] One undecodable queued payload bricks every write —
      `pendingOpFromRow`/`eventFromRow` use bare `JSON.parse` +
      `decodeUnknownSync` (`rows.ts:215,228,306`) while `taskFromRow` uses
      the tolerant `parseJson` (`:104`). `listAll()` runs on every mutation
      (`mutations.ts:89-92`) and behind `listPendingOps`, so a payload that
      stops decoding after a schema change kills all writes and the discard
      UI that would fix it. Version-tag the payload, decode tolerantly,
      quarantine the row.
- [ ] Coalesce-then-enqueue is not transactional — `updateEvent`
      (`mutations.ts:530-547`), `updateRecurring`, `deleteRecurring`,
      `setCalendarColor`, `respondToEvent`, and the task `updateTask` /
      `deleteTask`: a crash between `removeForEvent` and `enqueueAndKick`
      leaves a `pending` row with no op — the edit never reaches Google and
      the next pull overwrites it. `sql.withTransaction` is already used by
      `accountRepo.remove`, `replaceMirror`, `replaceTier`. Batch
      `EventRepo.upsertMany` (`repos.ts:410-413`) too: a sync page applies
      partially on failure.
- [ ] Orphan `local-…` task rows — a createTask that gets a permanent 4xx
      returns `'done'` (`applyOp.ts:320`); the optimistic row from
      `insertLocal` stays `sync_status='pending'`, which `deleteStale`
      (`repos.ts:723-730`) never collects. It renders forever.
- [ ] Task `sync_status` protects creates only — `setStatus`/`updateLocal`
      (`repos.ts:861-912`) leave `sync_status`/`synced_at` untouched; the
      docs and the Tasks decision entry read as if edits and completions
      were protected from the daily full-pass reconcile. Mark them, or fix
      the docs and rely on push-before-pull (which has a backoff exception).
- [ ] `truncateRecurrence` rewrites `RRULE:` lines only
      (`core/recurrence/editing.ts:63-77`): `RDATE` occurrences after a
      "this and following" split survive in the old series.
- [ ] Malformed timestamps are defects — `Temporal.Instant.from` throws
      synchronously in `mapEvent.ts:11-13`, `mapTask.ts:24,34`,
      `engine.ts:86-89`; one bad row fails the calendar's pass forever,
      logged only as a warning. Decode tolerantly, skip the row loudly.

## Tier 2 — robustness of the sync path

- [ ] Desktop token store (`apps/desktop/electron/tokens/safeStorageStore.ts`)
      — non-atomic `writeFileSync` (a crash mid-write truncates the blob and
      every account re-auths); no `safeStorage.isEncryptionAvailable()`
      guard (an `encryptString` throw is a defect out of a `never`-error
      `set`); read-modify-write over the whole map while `TokenManager`'s
      lock is per account (two refreshes lose a write); file + Keychain read
      on every authed request; decrypt failures swallowed to `null` (silent
      sign-out). The iOS store (per-account expo-secure-store keys) has none
      of these. Temp-file + rename, guard, cache, typed failure.
- [ ] Indexes and bounds — `pending_ops` has no index (`migrations.ts:61-74`)
      and `listDue` no LIMIT (`repos.ts:482-487`); `tasks` has no `due_date`
      index although the complete Reminders mirror makes it the largest
      table (`getWindow` range-scans it, `repos.ts:731-741`);
      `idx_events_range` leads with `calendar_id`, which `EventRepo.getWindow`
      never filters on, so it degrades to a scan; the masters query has no
      lower bound (`repos.ts:383-388`) so every recurring master ever stored
      is expanded on every window; `getEventsInRange`/`listPendingOps`/
      `searchContacts` have no rpc-side caps.
- [ ] Sync-loop nits, one PR — `syncRemindersOnly` lacks the per-account
      `catchCause` that `syncAll` has (`engine.ts:668-684` vs `:632-652`);
      the second `pass(undefined)` after `needsFull` does not re-check
      `skipped` (`:583-588`); `retryAfterMs` is parsed off 429s
      (`requestCore.ts:46-50`) and ignored by `withTransientRetry`
      (`engine.ts:66-73`); the 410/404/412/429 branches never consume
      `response.json` (`requestCore.ts:115-131`); `DeviceContacts.list()`
      refresh is not single-flighted and a failed snapshot caches `[]` for
      5 min (`deviceContacts.ts:61-70`); migrations have no monotonic-id
      guard (`migrate.ts:61`); `catchCause(() => 'retry')` (`applyOp.ts:356`)
      retries an undecodable 200 forever at the 30-min cap.
- [ ] Electron hardening (all four clauses of the 2026-08 item are open) —
      no CSP (`index.html`, no `onHeadersReceived`); no `will-navigate` /
      `web-contents-created` guard, so a renderer navigation hands remote
      content the whole `calendarBridge` incl. `rpcSend`;
      `setWindowOpenHandler` opens any `https://` (`main.ts:63-69`) fed by
      `meetingUrl()` scanning invite-controlled description/location, plus
      `window.open(task.webViewLink)` — allowlist hosts; the three `model:*`
      handlers forward raw `unknown` incl. unbounded `audioBase64`
      (`modelHelper.ts:22-40`) while `privacy:set` is allowlisted; helper
      request timeout never kills the child (`helperProcess.ts:238-249`), a
      wedged helper stays wedged until quit; `renderer-error` is unbounded
      (`main.ts:22-24`); `privacy.ts:88-92` writes settings non-atomically.
      Keep: sandbox, contextIsolation, contentProtection are right.
- [ ] Adapter drift into packages — the `addAccount` tail is duplicated
      line for line (`backendHost.ts:118-146` ↔ `backend.ts:113-152`) →
      `finishAddAccount({ result, generateId })` in sync; `kickSync`'s 15 s
      debounce twice (`backendHost.ts:178-201` ↔ `backend.ts:172-192`); the
      four bridge clients are one shape (`makeBridgeLayer`);
      `changesFromSubscription`/`bridgeMessage` live in `@calendar/reminders`
      and `@calendar/contacts` depends on it only for them → neutral home.
      iOS has no `CALENDAR_REMINDERS=off` / `CALENDAR_CONTACTS=off` switch.

## Tier 3 — cost and CI

- [ ] Docs-only pushes run all four macOS jobs (`e2e` 25 min cap,
      `e2e-reminders` 30, `ios-e2e` 45, `package-smoke` 25 — up to 125 wall
      minutes at the private-repo multiplier; the spending limit was hit on
      2026-09-05). Add a `changes` filter job (dorny/paths-filter or
      `git diff --name-only`) and `if:` guards on the macOS jobs — not
      `paths-ignore`, which makes required checks never report.
- [ ] Gate duplicated byte-for-byte in `ci.yml:21-35` and `ios.yml:52-66`
      → one `workflow_call` reusable workflow. The desktop app is built
      twice per PR (`e2e` on macos-15 and `e2e-reminders` on macos-26).
- [ ] Caches — `apps/desktop/helper/.build` (cold `swift build -c release`
      in two jobs; `testing-build`'s 30-min budget is tight cold),
      `~/Library/Caches/electron` (prefetched at `ci.yml:55`, never cached),
      `~/.maestro`, hoisted `node_modules` (the link phase, not the store,
      is the slow part).
- [ ] Supply chain — `curl get.maestro.mobile.dev | bash` runs in the job
      whose env holds `EXPO_TOKEN` (`ci.yml:118,156`): pin a Maestro version + checksum and scope the token to the steps that need it; SHA-pin
      `pnpm/action-setup`; add `dependabot.yml`; `.github/` has no
      CODEOWNERS or PR template.
- [ ] Flake budget — no `vitest` `retry` on e2e specs; every flake is a
      full macOS job rerun.
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
- [ ] Distribution gaps — the macOS testing build cannot sign in (no OAuth
      config baked in; embed the non-confidential RFC 8252 desktop client
      config); no versioning or changelog (`0.0.0` everywhere, iOS and
      macOS build identities uncorrelated — a tester cannot say which build
      they are on across platforms); auto-update stays a no-op until the
      repo is public or a token-fed feed replaces `update-electron-app`
      (the Forge GitHub publisher config is dead weight until then); no
      crash reporting in production builds — a deliberate decision to make
      against the privacy posture, not an oversight.
- [ ] Real app icons (macOS .icns / Assets.car, iOS icon set) — nothing
      exists: `forge.config.cjs` has no `icon`, `app.json` no `expo.icon`;
      every artifact ships the stock Electron / Expo icon. Logo design
      notes first (see Later).

## Tier 4 — developer workflow and test coverage

- [ ] Untested load-bearing pure code (the 2026-08 item, grown) —
      `assembleWindow` (`core/recurrence/window.ts`, every rendered event
      flows through it; its first direct tests landed with the override
      scoping fix, keep adding cases); `editorModel.ts` 287 +
      `taskEditorModel.ts` 245 + `quickAddModel.ts` 215 + `hooks.ts` 234
      = 981 untested lines behind the shared editors; `rows.ts` 332
      (encode/decode); `apiTypes.ts` optional-field tolerance;
      `tasksClient.ts`; `deviceContacts.ts`; `allDayLane.ts`;
      `apps/desktop/electron/{helperProcess,privacy,main}.ts`.
- [ ] A fake Google server — there is none: every semantic in
      `docs/google-sync-and-testing.md:3-115` (410 sync-token expiry,
      tombstones, watermarks, `EXPIRED_SYNC_TOKEN` as a 400, 412, instance
      ids) is prose, and the HTTP layer + poll/push/pull loop are exercised
      only by hand against production Google. An in-process
      `effect/unstable/http` handler layer replaying JSON fixtures is the
      single highest-value testing addition and would let e2e cover sync.
- [ ] Git hooks and scripts — no hooks at all; `vp config` + a `staged`
      block in `vite.config.ts` stops the sorted-keys lint class at commit
      time. `pnpm test` is watch mode in a TTY (add `test:run`); no root
      `build`/`lint`/`coverage` scripts; `pnpm typecheck` is cold every run
      (no project references / incremental).
- [ ] Manual steps with no guard — `build:helper` is not wired into
      `desktop build`, so `test:e2e` can run against a stale or absent
      helper; nothing warns when the installed dev client's fingerprint ≠
      the working tree's; `expo prebuild` after `app.json` edits. Maestro
      needs a JDK (`brew install openjdk`, `JAVA_HOME`) — say so in README.
- [ ] Housekeeping leftovers — `packages/ai` errors → `Data.TaggedError`
      (`model.ts:38`, `speech.ts:12,17`); three copies of the bounded LRU in
      `app-state/src/atoms.ts` (~98-130, ~142-170, ~173-205);
      `uncaughtException` should exit after logging (`log.ts:52-54`);
      `app.json` `expo.updates` lacks `checkAutomatically` + a fallback
      timeout; `weeks[0]![0]!` in `core/time/ranges.ts:73-74`; unchecked
      `as` casts on DB enums in `rows.ts` vs the Set-guarded casts in
      `mapEvent.ts:36-38`; `@types/react` hardcoded in three manifests
      instead of the catalog.

## Tier 5 — parity, UX, accessibility

- [ ] iOS parity gaps — no week view (`App.tsx:41`); no ambient pending-ops
      indicator (only inside Settings, `SettingsSheet.tsx:97-119`, and it
      prints raw op kinds); the all-day lane is a fixed 34-pt single row
      that clips at 3+ items (`DayTimeline.tsx:33,481-491`) vs desktop's
      packed `layoutAllDayLane`; permission status shows raw enum strings
      in Diagnostics vs desktop's `STATUS_COPY`; `ErrorBoundary` only
      `console.error`s, so a TestFlight render crash leaves no artifact.
- [ ] Desktop keyboard and dialogs — the event editor and settings modal
      have no `role="dialog"`, no focus trap/restore, and **Escape closes
      only ⌘K** (`CalendarApp.tsx:124`); day columns and event blocks are
      mouse-only `<div>`s (`WeekView.tsx:326-403`), so an event cannot be
      opened without a mouse; one shortcut in the whole app.
      `CalendarColorButton.tsx:60-77` is the pattern to copy. Add ⌘N, T /
      arrow-key navigation, ⌘, and ⌘W.
- [ ] iOS VoiceOver — header icon buttons carry `testID` but no
      `accessibilityLabel` (`App.tsx:127-152`: ‹ › ＋ ⚙ are read as
      glyphs); same for WeekStrip/MonthGrid day cells and every editor
      Pressable; no `accessibilityViewIsModal`; fixed `fontSize` everywhere.
- [ ] Quick-add divergence — desktop `CommandBar` passes no `fallbackDate`
      (`CommandBar.tsx:41-56` vs `QuickAddBar.tsx:83`), so "lunch on
      Friday" resolves against today while a different week is on screen;
      it checks model status once at mount with no retry (iOS re-checks on
      AppState active, has a Retry button). One `useModelAvailability`.
- [ ] Invitee field parity — iOS `InviteeField` has no debounce (one rpc +
      one LRU atom per keystroke), no arrow keys / comma / Backspace-removes-
      chip, no stale-row dimming; desktop `InviteeCombobox` has all of it.
      One `useInviteeField` hook.
- [ ] Shared-code moves (~400 lines) — editor labels exist in three drifted
      copies (`taskEditorOptions.ts` ↔ `editSheetShared.ts:30-54` ↔
      `EventEditor.tsx:16-26`: "Does not repeat"/"None", "This and
      following"/"This + following"); `pendingOpLabel`; permission status
      copy; byte-identical `slotLabel`, `formatTime`, `listColorOf`;
      `rangeFor/titleFor/step/panByDays` → `useCalendarNavigation`.
- [ ] Add flow: pick the correct calendar — prefill works end to end, but
      `editorModel.ts:96-102` always defaults to `writableCalendars[0]` and
      `EventEditorPrefill` has no `calendarId`. Remember the last-used
      calendar, prefill from the visible selection.
- [ ] Splits — `SettingsSheet.tsx` 690 (PrPreview/Diagnostics sections are
      already standalone functions), `DayTimeline.tsx` 614, `WeekView.tsx`
      425 (`DayHeaders`/`AllDayLane`/`TimedGrid`, also the perf vehicle),
      `EventEditor.tsx` 381 (extract `EventEditorForm` like iOS did),
      `db/src/repos.ts` 1063.

## Tier 6 — performance

- [ ] Drag re-renders the whole `WeekView` per `pointermove`
      (`useEventDrag.ts:130` `setPreview`): filters, `taskSpans`,
      `layoutAllDayLane`, `layoutDayColumn` × 11 columns per pointer event.
      `useWheelPan` already shows the CSS-variable pattern (zero renders per
      wheel event) — move the preview to a var on the dragged block, or
      memo the layouts on `[events, tasks, strip]`. `useNow()` re-renders the
      whole grid every minute on both platforms (`WeekView.tsx:63`,
      `DayTimeline.tsx:337,459`) → a `<NowIndicator/>` that calls it
      itself. 264 hour-line divs per render (`WeekView.tsx:339-345`) → one
      `repeating-linear-gradient`.
- [ ] Month views call `eventsOnDay` (filter + sort + alloc) per cell × 42
      (`MonthView.tsx:23,38`, `MonthGrid.tsx:23,46`) → one grouped
      `Map<isoDate, EventRecord[]>` built once.
- [ ] Atom fan-out — `eventsInRange` subscribes to `CALENDARS_KEY`
      (`atoms.ts:109`), so a color change or visibility toggle refetches
      every mounted range (full `getEventsInRange` + expansion);
      `tasksInRange` to `TASKLISTS_KEY`; `useBackendMutations` creates 19
      subscriptions + a 19-dependency memo per consumer (`hooks.ts:135-234`)
      and is called several times per tree.

## Tier 7 — features (near-term, well-scoped)

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

## Tier 8 — AI features

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
