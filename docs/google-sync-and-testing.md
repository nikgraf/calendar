# Google API semantics & testing notes

## Verified Google Calendar API semantics

Everything below is either verified against the reference docs or proven by
the implementation + tests. When touching sync code, treat these as
invariants.

### Events & recurrence

- **Instance / exception ids**: an occurrence of a recurring event has id
  `<masterId>_<YYYYMMDDTHHMMSSZ>` (basetime = original start in UTC,
  compact); all-day: `<masterId>_<YYYYMMDD>`. Exception events created by
  modifying an occurrence keep that id — which is why our local override
  rows use it (`googleInstanceId` in `packages/core/src/recurrence/editing.ts`):
  the later sync pull upserts over them idempotently.
- Patching an instance id creates/updates the exception server-side;
  deleting an instance id cancels that occurrence (even if no exception
  row exists yet).
- **RRULE editing**: `UNTIL` must be UTC-basic format
  (`YYYYMMDDTHHMMSSZ`) for timed events, `YYYYMMDD` for all-day; `COUNT`
  and `UNTIL` are mutually exclusive (RFC 5545) — truncation drops COUNT.
  Recurrence lines never include DTSTART; it derives from the event start.
- **Client-generated event ids** (base32hex) make creates idempotent: a
  409 on insert means the create already landed — treat as success.
- **PATCH semantics**: omitted fields stay unchanged. Attendee arrays
  merge by email for non-organizer callers, and `responseStatus` changes
  for entries other than your own are ignored — RSVP therefore sends an
  attendees-only body and deliberately omits If-Match (a response should
  not lose to unrelated content edits).
- **Attendee editing**: `attendees` on `EventDraft`/`UpdateEventChanges`
  is a replacement guest list (`[]` clears). Google **replaces the whole
  array** on write and our copy lacks fields we never model (`optional`,
  `comment`, `additionalGuests`), so the array rides only on inserts and
  on updates whose op is flagged `attendeesChanged` (a coalesced later
  edit inherits the flag); a title-only patch omits it. Rooms
  (`resource: true`) are kept in the record flagged `isResource`, hidden
  from the editor, and carried over by `mergeAttendees`, which also keeps
  the server facts (response, organizer, self) of retained emails so a
  guest edit never resets an RSVP. Inserts/patches send `sendUpdates=all`
  when guests exist (rooms alone do not count) or the guest list was
  edited (removed guests get their cancellation) — guests get emailed
  about time/location edits too. The organizer is never added
  client-side: Google puts it on the insert response.
- **412 (etag mismatch)**: we use If-Match on content updates/deletes when
  an etag is known; on 412 the op is parked with Google's copy
  (`events.get`) and the user keeps theirs (re-sent without If-Match) or
  takes Google's (re-fetched live). `events.get` answers a deleted event
  with 404 or 410 — the client maps both to `NotFoundError` (a 410 is not
  an expired sync token there).

- **events.move** (`POST …/events/{id}/move?destination=`): re-homes an
  event into another calendar _of the same account_, keeping its id,
  guests, conference data and exceptions. Organizer only (403
  `forbiddenForNonOrganizer` otherwise) and whole events only — an
  instance id is refused. We send `sendUpdates=all` when the event has
  guests. The fake server implements exactly this (source tombstone,
  destination upsert, 403/400/404 arms).

- **reminders**: `{useDefault, overrides?: [{method, minutes}]}` on
  every event resource (no `fields` param is sent, so it always
  arrives). `useDefault: true` means the calendarList entry's
  `defaultReminders` apply; `useDefault: false` with no overrides means
  none — keep the two apart. `overrides` holds at most five, `minutes`
  0..40320 (four weeks); methods `email` and `popup` (an `sms` override
  from an old account is dropped on read). PATCH replaces the whole
  object, so a flagged update always sends `useDefault` plus every
  override, email ones included, and an unrelated edit sends none. For
  an all-day event `minutes` count from local midnight of the start day
  in the calendar's time zone _(verify against the web UI: 420 should
  read "the day before at 5:00 PM")_. Local delivery only fires
  `popup` reminders; `email` is Google's to send.

### calendarList

- `calendarList.patch?colorRgbFormat=true` accepts arbitrary
  `backgroundColor`/`foregroundColor` hex; send **both** (foreground is
  not documented optional; omitting it has 400 reports). Google sets the
  nearest palette `colorId` automatically and subsequent lists return the
  custom `backgroundColor` — and `mapGcalCalendar` prefers
  `backgroundColor` over `colorId`, so custom colors round-trip with no
  mapper changes.
- **URL-encode calendar ids** in paths: birthday/holiday calendars contain
  `#` (`addressbook#contacts@group.v.calendar.google.com`) — unencoded,
  the id is truncated as a URL fragment.
- Colors must be full 6-digit hex; Google normalizes casing — we store
  lowercase (`normalizeHexColor`) so pull-after-push is byte-identical.
- The calendarList entry is per-user metadata: color patches work for any
  accessRole, including read-only calendars.

### Misc

- Locations: `location` is free-form text and the only location field
  on a regular event — no place id, no coordinates (Google's own clients
  geocode the string too). The app mirrors coordinates it derived into
  `extendedProperties.private` (`solunivo.geo` = `lat,lng`,
  `solunivo.geoName`, `solunivo.geoSource` = the exact location text).
  Limits: keys ≤ 44 chars (longer keys are silently dropped), values ≤
  1024 chars (silently truncated — so a longer location is never
  mirrored), ≤ 300 properties / 32 kB per event. PATCH merges private
  keys; a key is deleted only by sending it as `null`. Private
  properties belong to one copy of the event: an attendee's copy on a
  calendar we cannot write never gets them, which is why a local
  `location_geo` cache exists. The fake Google server mirrors the merge
  and null-delete semantics.
- Meeting links: `hangoutLink`, else `conferenceData.entryPoints[]` with
  `entryPointType === 'video'`; `meetingUrl()` in core also scans
  location/description for Meet/Zoom/Teams/Webex/Whereby URLs.
- Sync: incremental via syncTokens; 410 → drop token, full resync,
  `deleteStale`. A sync token is bound to the query parameters of the list
  that issued it: a token from a `timeMin` list only ever reports changes
  inside that window and cannot be widened later. The events pass
  therefore sends no `timeMin` at all (full history), and a stored token
  is only ever one from such a list. `singleEvents=false` + `showDeleted=true` on the
  full list; `maxResults=2500` (the API's cap) — a 50k-event calendar is
  ~20 requests. The special birthday/holiday calendars flow through the
  normal calendarList (the Birthdays calendar is skipped, see contacts).

### Google Tasks (shipped)

- Separate API with no syncTokens: we poll with an `updatedMin` watermark
  (stored per account in `sync_state`, advanced to now−60s for clock
  skew) + `showCompleted/showHidden/showDeleted` so completions and
  deletions arrive as tombstones; a daily full pass catches anything a
  watermark can miss, then `deleteStale` (only `sync_status='synced'`
  rows).
- `due` is **date-only** (RFC 3339 with a meaningless time part) and
  there is **no recurrence exposure** — Google materializes the next
  occurrence of a repeating task when the current one completes.
- **Task ids are server-assigned** — creates are NOT idempotent (no
  client-id trick like events). See architecture.md for the temp-id +
  adopt-before-retry protocol.
- Completing sets `status: 'completed'` (Google also sets `hidden`);
  un-completing must clear `completed` via `status: 'needsAction'`.
- A 403 insufficient-scope (grants that predate the tasks scope) disables
  tasks for the account instead of retrying.

### Exercised end to end: the fake Google server

`packages/sync/src/testing/fakeGoogle.ts` is an in-process Calendar +
Tasks API behind effect's `HttpClient`, and `engine.http.test.ts` runs
the real clients, request core and sync engine against it: full then
incremental passes with sync tokens, a 410 forcing a full resync whose
`deleteStale` drops vanished rows, cancelled tombstones, If-Match → 412
parking the op and both resolutions (single-event `GET` included), client-generated event ids, the `updatedMin`
watermark with deleted task tombstones, and server-assigned task ids.
Before this the semantics above were documented prose only. The fake
pages event lists (`pageSize`, default 2,500; the sync token rides only on
the last page) and reports a removed calendar as a `deleted` calendarList
entry on incremental passes. Note: the engine reads `Clock`, and
`it.effect` runs under `TestClock` — advance it between passes or
`passStartedAt` never moves.

Both apps can run against the same fake (`testing/googleFixture.ts`):
desktop with `CALENDAR_GOOGLE=fixture` + `CALENDAR_GOOGLE_FIXTURE=<json>`
(the e2e harness's `google: { fixture }` launch option), iOS with
`EXPO_PUBLIC_CALENDAR_GOOGLE=fixture` at Metro start (CI does; the
fixture is `apps/ios/e2e/fixtures/google.ts`). A `GoogleFixture` names
accounts, calendars, task lists and tasks; only the account rows are
seeded locally, everything else arrives through the first sync, and a
pre-filled memory `TokenStore` keeps the real `TokenManager` and request
core on the path. The fake stamps writes with the wall clock (`live`) so
the device-time `updatedMin` watermark clears them. Desktop
`taskConvertGoogle.e2e.ts` and iOS `16-task-convert.yaml` use it to watch
a queued task create push and its `local-…` id become a server id.

### Live Google suite (real account)

The fake pins what we _believe_ Google does; the live suite checks it
against Google itself, signed in as a dedicated throwaway account, at
three levels: the Node engine suite (`packages/sync/src/live/*.live.ts`
— the real clients, request core, `SyncEngine` and `EventMutations` over
`FetchHttpClient` with a fresh in-memory database per test), the desktop
spec `apps/desktop/e2e/googleLive.e2e.ts` (the built Electron app signed
in as that account) and the iOS flows under `apps/ios/e2e/live/`. None of
them run in `pnpm test`, `pnpm test:e2e` or `pnpm test:e2e:ios`: they
need the token, they write to the account, and they take minutes.
`.github/workflows/google-live.yml` runs all three nightly when `main`
moved since the last completed run, on `workflow_dispatch`, and on PRs
labelled `google-live`, one run at a time (`concurrency: google-live`).

- **Setup (once).** A fresh Gmail account (sign into Calendar and Tasks
  once; unsubscribe the holiday calendars — every pass lists every
  calendar). The GCP project's OAuth consent screen must be **In
  production**: in Testing status refresh tokens expire after seven days.
  Then `node scripts/google-live-token.mjs --write` — the desktop OAuth
  client (`GOOGLE_DESKTOP_CLIENT_ID/SECRET` or
  `apps/desktop/google-oauth.local.json`), a loopback PKCE flow, the
  app's scopes plus the full `calendar` scope (calendars.insert/delete
  need it). It writes the gitignored `google-live.local.json` and prints
  the `gh secret set` lines for `GOOGLE_LIVE_EMAIL` and
  `GOOGLE_LIVE_REFRESH_TOKEN`; the workflow reuses
  `GOOGLE_DESKTOP_CLIENT_ID/SECRET` and fails red when any is missing.
  The refresh token is bound to the desktop client, so iOS refreshes it
  with that client too (`EXPO_PUBLIC_CALENDAR_GOOGLE_LIVE_CLIENT_ID/
SECRET`), not with `app.json`'s iOS client.
- **Isolation.** Every file (desktop spec, iOS job) creates its own
  secondary calendar and/or task list named
  `e2e-<unixSeconds>-<runTag>[-suffix]` (`GOOGLE_LIVE_RUN_TAG` —
  `gh-<run>-<attempt>-<job>` on CI, `local-<pid>` locally), deletes it
  in `afterAll`, and first sweeps anything older than six hours that a
  crashed run left behind (`LiveScratch.sweep`; younger ones may belong
  to a run in flight — a local run overlapping CI is fine). One calendar
  per file, not per test: Google throttles secondary-calendar creation.
  Titles carry `live-<runTag>-…`; tests assert on their own ids and
  never touch the primary calendar. Guests are `guest-<runTag>@example.com`
  (reserved, never delivered) and every write with guests goes out with
  `sendUpdates=none`: `GuestNotifications` (`packages/google`, a
  `Context.Reference` defaulting to `'all'`) is `'none'` in the live
  layers only.
- **Recipe.** `packages/sync/src/testing/liveScratchRest.ts` is the
  admin side as plain `fetch` (no Effect, no workspace imports, so Node
  24 runs it unbundled): scratch calendars/lists, the sweep, and "the
  other device" — raw event/task writes without If-Match. `liveWire.ts`
  is the host half (`liveWireLayer`: `FetchHttpClient` + a memory
  `TokenStore` holding the refresh token with `expiresAt: 0`, so the very
  first request goes through the `TokenManager` refresh; `seedLiveAccount`)
  — free of Node imports so the iOS bundle can carry it. `liveGoogle.ts`
  adds the Effect `LiveScratch` service over the app's own
  `TokenManager`, `liveEngineLayer` (engine.http.test.ts's recipe with the
  live wire) and `makeScratchRuntime` for `beforeAll`/`afterAll`. Tests
  use `it.live` (real `Clock` — the tasks watermark, `passStartedAt`
  and token expiry all read it); never `TestClock`. `vite.config.ts`
  switches on `GOOGLE_LIVE=1`: only `packages/sync/src/live/**/*.live.ts`,
  one file at a time, 120 s timeouts, no retry (a retry repeats real
  writes).
- **What the Node files pin.** `events`: the events sync token and an
  `idle` state, client ids and the ack's etag, a re-posted client id →
  409, an incremental pass applying a rename and a cancelled tombstone,
  PATCH-merge (a title-only patch keeps description/location), delete
  with If-Match (then `events.get` answers `cancelled` or 404/410), the
  geo extended-property keys (insert, untouched by an unrelated edit,
  nulled by a location change), reminder overrides replaced whole, the
  calendarList colour patch. `calendarList`: a calendar created after
  the first pass arrives incrementally and its deletion cascades (rows,
  events, `events:<id>` sync state). `recurring`: a weekly master, an
  instance edit under `<master>_<basetime>` with `recurringEventId`, a
  cancelled instance the pull keeps hidden, this-and-following (UNTIL
  master + new master), a series rename sparing the exception. `move`:
  `events.move` keeps the id and leaves a tombstone, an edit queued
  before a move lands after it in the destination, a master takes its
  exception along. `attendees`: Google adds the organizer, an RSVP is an
  attendees-only PATCH without If-Match (lands on a stale etag), a
  title-only edit keeps guests, `attendees: []` removes them, a content
  edit on the stale etag parks. `conflicts`: `parkedEdit` against Google
  (park with Google's copy, pull leaves the local version, take theirs,
  keep mine without If-Match, a parked delete, an edit of a deleted event
  restored under a new id). `tasks`: both lists, temp id → server id,
  date-only due, complete/uncomplete, the watermark pass picking a rename
  and a deleted tombstone (`syncUntil`: `updated` stamps can lag),
  adopt-before-retry (an identical task inserted "by the first attempt"
  is adopted, not duplicated — `noYield` stamps the op before the drain),
  a copy-then-delete move. `people`: both tiers finish with a sync token
  on an empty address book (`GOOGLE_LIVE_BIRTHDAY_NAME` names a contact
  with a birthday when one was added by hand). Not reachable on demand
  and therefore fake-only: 410 sync-token expiry, People
  `EXPIRED_SYNC_TOKEN`, 403 insufficient scope, 429/5xx, paging.
- **Desktop.** `CALENDAR_GOOGLE=live` + `CALENDAR_GOOGLE_LIVE=<json>`
  (`{email, refreshToken, tasksEnabled, contactsEnabled}` — the harness
  writes it into the run's temp profile, mode 600, deleted with it) and
  `CALENDAR_SYNC_INTERVAL_MS` (`SyncInterval`, a `Context.Reference` in
  `engine.ts`; the spec uses 10 s so a pull lands inside a poll). The
  spec always sets `select[aria-label="Calendar"]` / `"Task list"` to the
  run's own — a new event defaults to the last-used or first writable
  calendar, which on a real account is the primary. For a 412 it fills
  the sheet first and patches Google just before Save (the app's own
  poll could otherwise refresh the etag and defuse the conflict), and
  retries the round when a poll still won. Run:
  `E2E=1 CALENDAR_E2E_GOOGLE=live pnpm exec vp test run apps/desktop/e2e/googleLive.e2e.ts`.
- **iOS.** Metro must start with `EXPO_PUBLIC_CALENDAR_GOOGLE=live`, the
  four `EXPO_PUBLIC_CALENDAR_GOOGLE_LIVE_*` values and
  `EXPO_PUBLIC_CALENDAR_SYNC_INTERVAL_MS=30000` (inlined at bundle
  time — CI and local only, never an EAS update). The sidecar
  `scripts/google-live-scratch.ts setup --suffix ios` sweeps, creates the
  run's calendar and list, mints a one-hour access token and exports
  them as `MAESTRO_LIVE_*` (`--github-env` masks the token; `--export`
  prints shell lines) — the Maestro CLI injects every `MAESTRO_*` shell
  variable into each flow, and the refresh token never reaches Maestro.
  The flows (`e2e/live/flows/01…05`, tag `live`, outside `e2e/flows/` so
  the default suite never picks them up) run as explicit files in that
  order; behind-the-back edits and Google-side checks are `runScript`s
  (`e2e/live/scripts/*.js`, GraalJS with `http`, `json`, `output`)
  polled through `wait-for-event*.yaml` / `wait-for-task.yaml` with the
  `pause.yaml` idiom (an optional two-second wait for nothing — Maestro
  has no sleep). Calendar and list are picked by their unique names
  (rows share `id: calendar-option` / `task-list-option`). Maestro 2.10
  has no drag command, `longPressOn` releases after its press and a
  `swipe` from an element always starts at its centre, so neither the
  block's long-press-then-pan move nor its bottom-edge resize can be
  driven: 02 changes the event's shape through the all-day switch
  instead (the drag math has unit tests and the desktop live spec).
  `conflict-round.yaml` retries a round whose banner a poll defused. The
  chip's open/done glyph is not in the accessibility tree, so 04 proves a
  server-side reopen behaviourally: after two polls one tap must complete
  the task again on Google. Locally: `pnpm --filter @calendar/ios
test:e2e:live` (dev client installed, Metro up with the live env;
  `SIMULATOR_UDID` picks the device), which runs setup, the five flows
  and teardown.
- **Leaks.** Effect redacts `authorization` headers in logged causes; the
  desktop token file lives only in the temp profile; the iOS bundle on
  the CI simulator carries the secrets inlined (never shipped).

### Google People API (contacts cache)

- Two endpoints, two scopes: `people/me/connections` with
  `personFields=names,emailAddresses,birthdays` needs `contacts.readonly`;
  `otherContacts` needs `contacts.other.readonly` and only accepts a
  `readMask` of names/emailAddresses/phoneNumbers (no birthdays there).
  Changing `personFields` expires the stored sync token — People answers
  400 `EXPIRED_SYNC_TOKEN` and the engine runs one full pass, so a field
  added later self-heals on every install. Birthdays arrive as
  `birthdays[].date {year?, month, day}` with `year` 0 or absent for
  year-less dates; the primary entry wins, text-only entries are ignored. Both are _sensitive_
  scopes: existing accounts stay `contacts_enabled=0` until "Add Google
  Account" is re-run (in-place upgrade, same as tasks), and the People
  API must be enabled in the GCP project — the _People API_, not the
  library's _Contacts API_ (the retired GData product; the `contacts.*`
  scopes authorize People API calls). A disabled API answers 403
  `SERVICE_DISABLED`, which is a plain `GoogleApiError` (logged, flag
  left on), not the scope error that disables contacts. Both scopes are
  sensitive: Testing mode grants them to test users, Production needs
  Google's app verification.
- `requestSyncToken=true` returns `nextSyncToken` on the last page;
  incremental lists return tombstones as persons with
  `metadata.deleted: true`. Sync tokens expire after ~7 days; the People
  API reports that as **400 with `EXPIRED_SYNC_TOKEN`** (Calendar uses 410) — `GooglePeopleClient` folds both into `SyncTokenExpiredError`.
- `pageSize` max is 1000; the cache holds one row per (person, email),
  lowercased email for identity, original casing for display.

## Verified Apple Reminders (EventKit) semantics

- **Access**: `requestFullAccessToReminders` (macOS 14 / iOS 17+);
  `authorizationStatus(for: .reminder)` distinguishes fullAccess /
  writeOnly / denied / restricted / notDetermined. Access can be revoked
  in System Settings at any time — treat every pass's status check as the
  account's health, not the initial grant.
- **The helper is a bare executable**, so its usage strings ride in an
  embedded `__TEXT,__info_plist` (Package.swift `-sectcreate`); the app's
  Info.plist carries them too (forge `extendInfo`). Verified: both the
  dev Electron binary and the packaged .app obtain full access through
  the helper child and read the user's lists.
- **Ids**: `calendarItemIdentifier` is stable enough for a mirror but can
  change after an iCloud sync — the snapshot reconciliation makes that a
  delete + reinsert, never a stale row. Ids are server-assigned: no
  client-side idempotency trick, hence no queue. Deleting something
  Reminders.app already deleted answers notFound — treated as done.
- **Errors cross Expo as an envelope**: expo-modules-core rethrows a Swift
  throw as `FunctionCallException … → Caused by: RemindersBridgeError:
<message>`; the client unwraps the last `Caused by:` segment before
  matching the `accessDenied:` / `notFound:` prefixes (the helper sends
  the message verbatim).
- **Store lifetime**: the `EKEventStore` is created by the pre-prompt
  status call and `reset()` after a successful grant — a store created
  without access can keep answering with no calendars.
- **Due**: `dueDateComponents` with no hour ⇒ all-day (`dueDate` only);
  with hour/minute ⇒ timed (`dueTime` 'HH:MM' in the device zone). The
  bridge keeps `startDateComponents == dueDateComponents`, as the
  Reminders app does.
- **Priority**: EventKit 0…9; the Reminders app shows 1–4 high, 5 medium,
  6–9 low. We keep the buckets and write back 1/5/9/0.
- **Alarms**: only relative-offset alarms are surfaced (minutes, ≤ 0 =
  before/at); absolute-date alarms are preserved untouched by writes.
- **Recurrence**: freq/interval/count|until round-trip through
  `TaskRecurrence`; by-day / positional / multiple rules come back as
  `{ unsupported: true }`, the form shows them read-only, and writes
  never overwrite them.
- **Fetch**: one `predicateForReminders(in: nil)` — every reminder, open
  and completed, dated and undated. EventKit is local, so the fetch is
  cheap; the cost is the bridge payload on desktop, so `reminders.snapshot`
  returns all (listId, id) pairs plus full rows only for reminders whose
  `lastModifiedDate` ≥ `changedSince − 60 s` (the Google watermark's skew
  lag; re-reading the overlap is harmless — upserts apply only when
  strictly newer). Measured on a 9-reminder database: full 3.2 KB, idle
  delta 0.9 KB. The engine logs `reminders snapshot` at debug level with
  ids/changed/lists counts and fetch/apply ms; if a large completed
  archive ever makes a pass measurably expensive, the fallback is hybrid
  retention (all open, recent completed) — not built.
- **Change push**: `EKEventStoreChanged` fires for any EventKit change,
  including our own write-throughs and iCloud bursts; the engine
  debounces it (1 s) and runs a reminders-only delta pass under the sync
  gate, so bursts coalesce into one pass. It only reaches a live observer
  (the helper child can be respawned; iOS is suspended in the
  background), which is why the 90 s pass stays.

## Apple Calendar (EventKit events) semantics

Designed from Apple's EventKit documentation; the real-EventKit CI spec
(`appleCalendarReal.e2e.ts`) asserts connect, change push, edit and
delete through the helper. Items marked _(verify)_ are not yet asserted
against a real store — confirm them there before relying on them more.

- **Access** is its own TCC entity: `requestFullAccessToEvents` /
  `authorizationStatus(for: .event)`, independent of the Reminders
  grant. Same lifecycle as Reminders: `store.reset()` after a grant, the
  status check is the account's health, `writeOnly` is not enough.
- **Bounded queries only**: `predicateForEvents(withStart:end:calendars:)`
  matches a four-year span at most, so the bridge chunks longer ranges
  and de-duplicates events spanning a chunk edge by
  (`eventIdentifier`, `occurrenceDate`). EventKit expands series itself.
- **`eventIdentifier`** is shared by every occurrence of a series;
  `occurrenceDate` is the occurrence's original slot, unchanged when the
  occurrence is moved on its own. A detached occurrence keeps the
  series identifier _(verify)_. Ids can change after an iCloud sync —
  harmless for a read-through store (nothing to reconcile).
- **All-day events** end at the last day's end (some sources: the next
  midnight); the wire carries an exclusive `endDate`. A floating event
  has no `timeZone` and reads in the device zone.
- **Spans**: saving an occurrence with `.thisEvent` detaches it;
  `.futureEvents` on a later occurrence ends the series there and
  continues it as a new event; `.futureEvents` on the first occurrence
  rewrites the whole series. Setting `event.calendar` and saving the
  series' first occurrence with `.futureEvents` moves the series with
  its detached occurrences _(verify)_.
- **No attendee writes**: `EKEvent.attendees` is read-only; guests are
  shown, never edited. The organizer is matched by email.
- **Structured location**: `EKStructuredLocation.geoLocation` carries
  coordinates; assigning a structured location can rewrite the location
  text, so the bridge writes coordinates first and the text last. A new
  place name without new coordinates drops the old ones.
- **Alarms**: `EKEvent.alarms` holds relative (`relativeOffset`,
  seconds, negative = before) and absolute-date alarms. The bridge lists
  relative ones at or before the start as whole minutes and, on write,
  replaces that set while keeping absolute ones and alarms after the
  start (Calendar.app's all-day default "day of event, 9:00" is
  +540 min, which Google cannot express) — never shown, never dropped. For an
  all-day event the offset counts from local midnight, which matches
  Google's convention. There is no per-calendar default alarm in
  EventKit (Calendar.app's defaults are app preferences), so a Google
  "calendar default" is resolved into explicit popups when an event is
  copied to an Apple calendar, and `useDefault` or an email reminder on
  an Apple event is refused with `UnsupportedForProviderError`.
- **`EKEventStoreChanged`** fires for any EventKit change in any process
  (reminders and events alike) and only reaches a live observer; the
  Reminders bridge's observer and this one each react to both.

## Testing conventions

### Unit tests (`vp test`, @effect/vitest)

- Layer recipe: `EventMutations.layer` + `reposLayer` +
  `Layer.effectDiscard(runMigrations)` +
  `SqliteClient.layer({ filename: ':memory:' })` + reactivity layer +
  `Layer.succeed(GoogleCalendarClient, stub)` (+
  `Layer.succeed(GoogleTasksClient, tasksStub)` where tasks are
  exercised).
- The stubbed `GoogleCalendarClientShape` / `GoogleTasksClientShape` are
  **complete records** — every new client method must be added to every
  stub (typecheck enumerates them).
- AI pipelines never hit a real model in tests: the provider seams take a
  fake `ModelProvider`/`SpeechProvider` returning canned JSON, so
  prompt-building, normalization, and error paths are fully unit-tested
  (see `packages/ai/*.test.ts` and `findTimePipeline.test.ts`).
- Apple Calendar never hits EventKit in tests: `makeFakeAppleCalendarClient`
  (`packages/apple-calendar/src/fake.ts`) keeps series the way EventKit
  does (master + rules, detached and deleted occurrences), expands them
  with core's expander and implements the span semantics above, so
  scope and move tests assert what EventKit "saw" via `fake.state`.
  Layer recipes that build `EventMutations` provide
  `appleCalendarServicesLayer(unavailableAppleCalendarClient('test'))`.
  The desktop e2e reuses the fake in `CALENDAR_APPLE_CALENDAR=fixture`.
- Reminders never hit EventKit in tests: `makeFakeRemindersClient`
  (`packages/reminders/src/fake.ts`) is an in-memory store with the
  bridge's semantics (server-assigned ids, null clears, list moves,
  windowed listing, switchable authorization); sync/mutation tests read
  `fake.state` to assert what EventKit "saw". Every other layer recipe
  provides `unavailableRemindersClient('test')`.
- **Date-independence is a hard rule for every test involving "now"**:
  inject the clock (`nowUtc` parameter) or build dates relative to today
  with wall-clock times via Temporal in an explicit zone — never pinned
  dates or UTC-offset literals. Three CI breakages came from tests that
  passed on the day they were written and decayed.
- `getWindow` joins visible calendars: tests asserting through it must
  seed a calendar row, not just events.
- The SQLite driver is Node's built-in `node:sqlite` (same in tests,
  Electron, and CI) — no ABI split, no alias twin.

### Desktop e2e (`pnpm test:e2e`, apps/desktop/e2e/)

Raw CDP over Node's native WebSocket (no Playwright): the harness launches
the built Electron app with `--remote-debugging-port` and an isolated
`CALENDAR_USERDATA` profile, seeds SQLite through the app's own
migrations/repos, drives real input events, and asserts against both the
DOM and the database.

Flakiness lessons (each caused a real CI failure — keep them enforced):

- **Integer coordinates only** for `Input.dispatchMouseEvent` — fractional
  coords mis-fire.
- **`scrollIntoView` before measuring** (harness `locate`): CI runners
  land the week grid at different scroll offsets, leaving early-morning
  blocks under the sticky header where clicks hit the header.
- **Weekday-agnostic seeding**: recurring seeds start `today − 3 days` and
  expectations derive from the first _visible_ instance — absolute
  "today"-based expectations broke every Sunday.
- **Teardown**: await the Electron process `exit` (with timeout) before
  deleting the temp profile, and `rmSync` with retries — otherwise
  ENOTEMPTY races on slower runners.
- **Fire-and-forget UI mutations can silently drop**: poll for the effect
  and re-click after ~3s of no movement; assert relative change
  (`< before`), not exact counts.
- React inputs need the native value setter + `input`/`change` event
  dispatch; `<select>` likewise (`HTMLSelectElement` prototype setter).
- Tests share one app instance and run in file order — later tests must
  tolerate earlier tests' data (relative assertions, unique titles).
- The harness launches the app with `CALENDAR_REMINDERS=off` by default,
  which makes the desktop RemindersClient unavailable: `reminders.e2e.ts`
  seeds an Apple account/list/reminder straight into SQLite and asserts
  the chip and form; a real EventKit sync would replace those rows (and
  prompt for access on a developer's Mac). `launchApp(seed, { reminders:
'real' })` opts a spec into the helper — only `remindersReal.e2e.ts`,
  which is `describe.skipIf` unless `CALENDAR_E2E_REMINDERS=real`.
- `CALENDAR_CONTACTS=off` does the same for the address book bridge
  (`launchApp(seed, { contacts: 'real' })` to opt in; nothing does yet).
  `launchApp(seed, { contacts: { fixture } })` writes a JSON address book
  (`CALENDAR_CONTACTS=fixture` + `CALENDAR_CONTACTS_FIXTURE=<path>`) that
  the app serves through the in-memory fake client — `birthdays.e2e.ts`
  uses it for device birthdays. The harness always sets
  `CALENDAR_NOTIFICATIONS=off` so a seeded birthday with reminders on
  never posts a real banner.
  `contacts.e2e.ts` seeds Google contact rows (`SeedData.contacts`) and
  drives the combobox through `input[aria-label="Invitees"]`: value
  setter + `input` event to type, synthetic `keydown` for ArrowDown /
  Enter, `[role="option"]` rows and `[data-invitee]` chips to assert.

### CI (.github/workflows/ci.yml + ios.yml)

- `gate` (ubuntu): check + typecheck + unit tests.
- `e2e` (macos-15): desktop build → e2e suite. GUI Electron runs fine on
  macOS runners; content protection does not affect CDP automation.
- `package-smoke` (macos-26, PRs only): unsigned `package:app` + packaged-
  contents assertions — packaging failures used to surface only post-merge.
- `e2e-reminders` (macos-26): the **real** EventKit path on the desktop.
  Builds the helper, seeds the runner's per-user TCC database
  (`apps/desktop/e2e/ci/grant-reminders-tcc.sh` — named columns so the
  per-macOS column drift does not matter; every plausible client identity,
  since TCC may attribute to the helper's signing identifier, bundle id or
  path, to Electron, or to the runner's responsible process; bundle-id
  rows carry the helper's compiled csreq), then `probe-helper-access.sh` requires
  `reminders.status` = fullAccess before `remindersReal.e2e.ts` runs. The
  seed is not an Apple-supported interface: when a new runner image
  breaks it the job is red with the `access` schema, tccd's own rows and
  its log lines in the output — adjust the seed to the identity tccd
  recorded, never make the probe optional. The e2e jobs prefetch the
  Electron binary (`electron --version`) and run spec files sequentially:
  two Electron apps starting together on a small runner raced the lazy
  binary download into "CDP page target not found". Locally:
  `CALENDAR_E2E_REMINDERS=real E2E=1 pnpm exec vp test run apps/desktop/e2e/remindersReal.e2e.ts`
  (creates and deletes reminders in _your_ database).
- `ios-e2e` (macos-26): Maestro against the **EAS** dev client. CI never
  compiles the app — `apps/ios/e2e/ci/fetch-dev-client.sh` looks up the
  `development-simulator` build for the commit's native fingerprint
  (`expo-updates fingerprint:generate`, the hash `ios.yml` compares),
  requests one only if none exists, and the extracted `.app` lives in the
  Actions cache under that fingerprint, so JS-only pushes download
  nothing. `prepare-simulator.sh` boots the newest iPhone, installs, and
  pre-grants Reminders with `simctl privacy grant reminders` (supported);
  Metro on the runner serves the commit's JS. Two things made the dev
  launcher's 10 s request timeout bite on the runner and are handled
  before it is opened: the bundle is warmed through the manifest's
  `launchAsset.url` (so the request shares Metro's cache with the
  client's), and the runtime version is pinned to the computed
  fingerprint through a CI-only `app.config.js` overlay
  (`e2e/ci/app.config.ci.cjs`, copied after the fingerprint step) —
  with the fingerprint policy Expo CLI re-runs a full project
  fingerprint for _every_ manifest request, ~2 s on a laptop and past
  10 s on the runner. The dev client is opened on `127.0.0.1`. Two Maestro invocations: the bootstrap flow, then the rest —
  Maestro ignores `config.yaml` execution order (maestro#2231).
- `testing-build` (macos-26, main only): signed + notarized arm64 zip
  incl. the Swift model helper — macos-26 is the only runner image with
  the FoundationModels SDK. See docs/distribution.md.
- `ios.yml` (main + PRs): fingerprint-gated — TestFlight build when the
  native fingerprint changed, otherwise `eas update`; PRs get a `pr-<n>`
  preview channel.
- `google-live.yml` (nightly-if-changed, `workflow_dispatch`, the
  `google-live` PR label): the real-account suites — `live-node`
  (ubuntu, `GOOGLE_LIVE=1`), `live-desktop` (macos-15, the one spec) and
  `live-ios` (macos-26, the ios-e2e steps with a live Metro plus the
  sidecar's setup/teardown around the five flows). `decide` fails red
  without the secrets and, on the schedule, compares `github.sha` with
  the last completed run's `headSha` (`gh run list`, `actions: read`) —
  a skipped night still completes at that sha. `concurrency:
google-live` keeps runs from overlapping on the one account. See "Live
  Google suite" above.
- Log lines may stringify effect causes containing HTTP requests; effect
  redacts auth headers (`"authorization":<redacted>` — verified), so
  tokens cannot leak into CI logs this way.

### iOS e2e (Maestro, apps/ios/e2e/flows/)

Text/testID-based flows (12: dev-client bootstrap, launch, navigation,
new-event sheet, accounts sheet, day swipe, quick-add, create event, task
lane, reminders form, real reminders, invitees, all-day event chip).
Flows carry `tags`: everything is `ci`; the strict
`10-reminders-real.yaml` is also `ci-reminders` — it connects, creates
through EventKit and deletes with no escape hatch, so `pnpm test:e2e:ios`
excludes it (`--exclude-tags ci-reminders`) and CI includes it on a
simulator whose grant `prepare-simulator.sh` seeded. Flow 09 is the
tolerant local sibling (a no-op until the simulator has a connected
list). Maestro runs a directory's flows in a non-deterministic order and
`config.yaml`'s `executionOrder` is not honored (maestro#2231), so CI
runs the bootstrap as its own invocation and every other flow must be
independent of what ran before — the real-Reminders flow connects an
account, after which the task form defaults to the Apple list, hence
`Edit (Task|Reminder)` in flow 08. On CI Metro runs with
`EXPO_PUBLIC_CALENDAR_GOOGLE=fixture`, so a fixture Google account
(`fixture@solunivo.test`, list "Mock Tasks", calendar "Mock Calendar") is
signed in for every flow and the Google halves of 07/08 and the whole of
16 (task convert) run against the in-process fake; locally they are
no-ops unless Metro was started with the same variable. Text selectors are whole-string
regexes: a list row's label is title + swatch + check mark, so rows are
picked by `id: task-list-option`; a chip body is tapped by its full text
(`[0-9]+:[0-9]+ !!! <title>` for a timed reminder), because `.*<title>`
also matches the checkbox's "Toggle <title>" label and toggles
completion instead of opening the editor. Flows that open the edit sheet `waitForAnimationToEnd` before tapping
inside it (a tap taken mid-slide missed on the runner); the header "+"
is tapped through `common/open-new-event.yaml`, which re-taps while the
sheet is missing (run 34852090635 tapped it once at the right
coordinates and nothing opened), and the
quick-add flow accepts the bar's "couldn't be read" outcome: a CI
simulator passes the model availability check yet cannot generate,
so the prefilled editor is asserted only where a model answers.
The bootstrap flow `launchApp`s the dev client and only then opens
`solunivo://expo-development-client/?url=…`. Relying on the URL to
launch the app was not reliable on a runner: run 34851193180 confirmed
the "Open in Solunivo?" alert and no launch followed, because the
diagnostics step had left Safari in front with a modal "download
'status'?" sheet (the CI step now terminates Safari after its screenshot,
and no longer sends the URL itself). With the client already running,
confirming the alert delivers the URL to a live process; the alert may
still appear (one per `simctl openurl`, and they stack), so
`common/confirm-open.yaml` confirms exactly one and cancels the rest: every further "Open" re-delivered the same URL to
the client while its first bundle was still starting, it re-fetched the
manifest mid-load and the process died with SIGSEGV ~150 ms after the
bundle ran (two runs that tapped "Open" four times failed; the runs that
tapped once passed). The flow's recovery loop also re-sends the link
when the launcher sits on a blank home screen (a launch request once sat
in SpringBoard for a minute), confirms an "Open in Solunivo?" alert that
arrives after `confirm-open.yaml` stopped waiting (while the alert is up
Maestro sees only the alert, so no other recovery branch can match), and
its waits are `optional` so one slow attempt cannot end the flow before
the final "Today" assertion. On failure the job waits
for the simulator's crash report (`~/Library/Logs/DiagnosticReports/
Solunivo-*.ips`, written a minute or so after the crash) and prints
its exception and faulting thread before uploading it.
Every flow starts with `runFlow: ../common/launch.yaml`
(launch, recover the dev client if its 10 s auto-reopen fell back to
the launcher home or its error screen, wait for "Today",
`waitForAnimationToEnd`): React Native's
SafeAreaView applies the top inset a beat after the first paint, so an id
tap taken as soon as "Today" is visible lands ~60 pt too high — in the
status bar — on every flow. On CI, `prepare-simulator.sh` also switches
expo-dev-menu's floating "Dev tools" button off through UserDefaults
(`EXDevMenuShowFloatingActionButton`): it sits exactly over the app's
settings gear. Maestro needs a JDK on PATH (Apple's `/usr/bin/java` stub
is not one: `brew install openjdk`, then
`JAVA_HOME=/opt/homebrew/opt/openjdk`). Maestro does not expose a reliable
press-hold-drag command, so the default suite checks timed/date-only
editor transitions; unit tests cover the shared drag math. Flow 09's
slow-swipe experiment requires an explicit opt-in:
`maestro test -e REMINDER_DRAG_TEST=true apps/ios/e2e/flows/09-reminders-form.yaml`.
A Reminders list must already be connected. A long swipe duration does
not configure a stationary hold before movement, so native gesture
activation is unverified and this experiment is excluded by default.
If it activates, the test requires a later quarter-hour, then checks the
same due time after an app restart and a reopened-editor save. The exact
delta is not asserted: a [selector swipe](https://docs.maestro.dev/api-reference/commands/swipe)
ends at a screen-relative position and cannot be combined with explicit
start/end coordinates. This experiment does not replace a native check.

Before claiming iOS reminder-drag coverage, run this manual check on a
simulator or device with a connected Reminders list:

1. In today's Day view, create a reminder due at 9:00 AM. Hold its title
   until it lifts (at least 250 ms), move it down by one hour of grid
   spacing, and release. It must land at 10:00 AM on the same day.
2. Reopen the reminder editor and check its date and 10:00 AM time. Close
   the editor, terminate and relaunch Solunivo, and check that both the
   time-grid block and reopened editor still show that date and time.
   Confirm the same due time in Apple Reminders, then delete the test item.

Selector gotchas (each caused a real
failure): Maestro text selectors are **whole-string regexes** — prefix
text does not match, and regex metacharacters in titles must be escaped;
never select by `local-…` task ids (the op push swaps them to server ids
mid-flow) — select by title/label text; avoid non-ASCII punctuation in
typed text (XCTest typing flakiness).
