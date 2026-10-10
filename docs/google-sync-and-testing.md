# Google API semantics & testing notes

## Verified Google Calendar API semantics

Everything below is either verified against the reference docs, proven by
the implementation + tests, or probed against a real account (the live
suite). When touching sync code, treat these as invariants.

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
  Google draws DTSTART as the first occurrence even on a day the rule
  skips, outside COUNT (probed live) — see architecture.md, Recurring
  events, for how `buildRuleString` matches that.
- **Client-generated event ids** (base32hex) make creates idempotent: a
  409 on insert means the create already landed — treat as success. A
  deleted event keeps its id reserved (re-insert → 409) and comes back by
  a PUT with `status: 'confirmed'`.
- **PATCH semantics**: omitted fields stay unchanged; PUT (`events.update`)
  clears what the body leaves out. Attendee arrays merge by email for
  non-organizer callers, and `responseStatus` changes for entries other
  than your own are ignored — RSVP therefore sends an attendees-only body.
- **PATCH merges `start`/`end` field by field** (verified live): a timed →
  all-day edit that sends only `{date}` keeps the stored `dateTime`, and a
  time carrying both is a 400 "Invalid start time". `toGcalTimesPatch`
  sends the unused form as null (`{date, dateTime: null, timeZone: null}`
  and the reverse); the fake merges and refuses the same way.
- **A master edit reaches the exceptions** (verified live): when a
  master's title, description or location **changes**, Google copies the
  new value onto every exception of the series, overridden ones included;
  a field re-sent with its old value leaves the exceptions' own values
  alone. `updateRecurring` (series scope) mirrors the changed fields onto
  the local override rows at save, as a projection of the queued op
  (`carriedText.ts`: the op keeps the text Google's master had and each
  exception's own text, so "changed" is measured against Google's text
  across coalesced edits, an empty field equals a missing one, and
  discard, take-theirs and a permanent rejection put the exceptions' text
  back except where the user has since edited the exception or a pull
  replaced the row). Known gap: a queued instance op's payload is not
  rewritten, so it can still push carried text of an abandoned series
  edit; the next pull converges.
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
  edited (removed guests get their cancellation). An API insert never
  adds the organizer to `attendees` (the web UI does): the organizer is
  the calendar itself (`organizer.self`), so the app refuses an RSVP
  there (`NotAttendeeError`).
- **412 (etag mismatch)**: we use If-Match on content updates/deletes and
  RSVPs when an etag is known; on 412 an update or delete is parked with
  Google's copy (`events.get`) and the user keeps theirs (re-sent without
  If-Match) or takes Google's (re-fetched live); an RSVP is resent
  unchecked. A stale-etag PATCH of a deleted event and a stale If-Match
  DELETE are 412s too. `events.get` answers a deleted event with 404 or
  410 — the client maps both to `NotFoundError`, and a 410 on any write
  means "gone", like a 404 (never an expired sync token there).
- **events.move** (`POST …/events/{id}/move?destination=`): re-homes an
  event into another calendar _of the same account_, keeping its id,
  guests, conference data and exceptions, and leaves a tombstone at the
  source. Organizer only (403 `forbiddenForNonOrganizer` otherwise) and
  whole events only — an instance id is refused. We send
  `sendUpdates=all` when the event has guests.
- **reminders**: `{useDefault, overrides?: [{method, minutes}]}` on
  every event resource. `useDefault: true` means the calendarList entry's
  `defaultReminders` apply; `useDefault: false` with no overrides means
  none — keep the two apart. `overrides` holds at most five, `minutes`
  0..40320 (four weeks); methods `email` and `popup` (an `sms` override
  from an old account is dropped on read). PATCH replaces the whole
  object, so a flagged update always sends `useDefault` plus every
  override, email ones included, and an unrelated edit sends none. For
  an all-day event `minutes` count from local midnight of the start day
  in the calendar's time zone. Local delivery only fires `popup`
  reminders; `email` is Google's to send.
- **Rate limits**: a burst of writes gets 403 `rateLimitExceeded`; the op
  backs off like any transient failure. Google also caps secondary
  calendar creation per account and day (403 `usageLimits` /
  `quotaExceeded` after ~40).

### calendarList

- `calendarList.patch?colorRgbFormat=true` accepts arbitrary
  `backgroundColor`/`foregroundColor` hex; send **both** (foreground is
  not documented optional; omitting it has 400 reports). Google sets the
  nearest palette `colorId` automatically and subsequent lists return the
  custom `backgroundColor` — `mapGcalCalendar` prefers `backgroundColor`
  over `colorId`, so custom colors round-trip. Colors must be full
  6-digit hex; Google normalizes casing — we store lowercase
  (`normalizeHexColor`) so pull-after-push is byte-identical. The
  calendarList entry is per-user metadata: color patches work for any
  accessRole, including read-only calendars.
- **URL-encode calendar ids** in paths: birthday/holiday calendars contain
  `#` (`addressbook#contacts@group.v.calendar.google.com`) — unencoded,
  the id is truncated as a URL fragment.
- **A deleted calendar lingers.** After `calendars.delete`, a full
  `calendarList.list` keeps naming the calendar for minutes and
  `events.list` still answers 200; later `events.list` turns 404 while the
  list may still name it, and an incremental list never reports a
  deletion that predates its token. A 404 is no proof of deletion either
  (Google's error guide says to retry it; it also covers "a calendar the
  user can not access"). So the engine skips that calendar for the pass,
  keeps its rows, and drops the calendarList token so the next pass
  lists calendars in full — which removes the calendar once Google stops
  naming it, and keeps it, retrying its events, if it recovers. A
  `tasks.list` 404 skips that list the same way.

### Misc

- Locations: `location` is free-form text and the only location field
  on a regular event — no place id, no coordinates. The app mirrors
  coordinates it derived into `extendedProperties.private`
  (`solunivo.geo` = `lat,lng`, `solunivo.geoName`, `solunivo.geoSource` =
  the exact location text). Limits: keys ≤ 44 chars (longer keys are
  silently dropped), values ≤ 1024 chars (silently truncated — so a
  longer location is never mirrored), ≤ 300 properties / 32 kB per
  event. PATCH merges private keys; a key is deleted only by sending it
  as `null`. Private properties belong to one copy of the event: an
  attendee's copy on a calendar we cannot write never gets them, which is
  why a local `location_geo` cache exists.
- Meeting links: `hangoutLink`, else `conferenceData.entryPoints[]` with
  `entryPointType === 'video'`; `meetingUrl()` in core also scans
  location/description for Meet/Zoom/Teams/Webex/Whereby URLs (Zoom and
  Webex only from the domain itself or a dotted subdomain).
- Sync: incremental via syncTokens; 410 → drop token, full resync,
  `deleteStale`. A sync token is bound to the query parameters of the list
  that issued it: a token from a `timeMin` list only ever reports changes
  inside that window and cannot be widened later. The events pass
  therefore sends no `timeMin` at all (full history), and a stored token
  is only ever one from such a list. `singleEvents=false` +
  `showDeleted=true` on the full list; `maxResults=2500` (the API's cap).
  The Birthdays calendar is skipped (see contacts).

### Google Tasks

- Separate API with no syncTokens: we poll with an `updatedMin` watermark
  (stored per account in `sync_state`, advanced to now−60s for clock
  skew) + `showCompleted/showHidden/showDeleted` so completions and
  deletions arrive as tombstones; a daily full pass catches anything a
  watermark can miss, then `deleteStale` (only `sync_status='synced'`
  rows). `updated` stamps can lag a write by a moment.
- `due` is **date-only** (RFC 3339 with a meaningless time part) and
  there is **no recurrence exposure** — Google materializes the next
  occurrence of a repeating task when the current one completes.
  `parent`/`position` are decoded and not modeled (todo.md).
- **Task ids are server-assigned** — creates are NOT idempotent (no
  client-id trick like events). See architecture.md for the temp-id +
  adopt-before-retry protocol.
- Completing sets `status: 'completed'` (Google also sets `hidden`);
  un-completing must clear `completed` via `status: 'needsAction'`.
- A 403 insufficient-scope (grants that predate the tasks scope) disables
  tasks for the account instead of retrying.
- A write to a task that is gone (verified live): PATCH of a task deleted
  on Google answers **200** with `deleted: true` (the edit lands on the
  tombstone; `mapGcalTask` maps it to null and the op settles); a task
  moved to another list answers **404** at its old list, and so does any
  task of a deleted list.

### Google People API (contacts cache)

- Two endpoints, two scopes: `people/me/connections` with
  `personFields=names,emailAddresses,birthdays` needs `contacts.readonly`;
  `otherContacts` needs `contacts.other.readonly` and only accepts a
  `readMask` of names/emailAddresses/phoneNumbers (no birthdays there).
  Changing `personFields` expires the stored sync token — People answers
  400 `EXPIRED_SYNC_TOKEN` and the engine runs one full pass, so a field
  added later self-heals on every install. Birthdays arrive as
  `birthdays[].date {year?, month, day}` with `year` 0 or absent for
  year-less dates; the primary entry wins, text-only entries are ignored.
- Both are _sensitive_ scopes: existing accounts stay
  `contacts_enabled=0` until "Add Google Account" is re-run (in-place
  upgrade, same as tasks), Testing mode grants them to test users,
  Production needs Google's app verification. The _People API_ must be
  enabled in the GCP project — not the library's _Contacts API_ (the
  retired GData product); a disabled API answers 403 `SERVICE_DISABLED`,
  a plain `GoogleApiError` (logged, flag left on), not the scope error
  that disables contacts.
- `requestSyncToken=true` returns `nextSyncToken` on the last page;
  incremental lists return tombstones as persons with
  `metadata.deleted: true`. Sync tokens expire after ~7 days; the People
  API reports that as **400 with `EXPIRED_SYNC_TOKEN`** (Calendar uses 410) — `GooglePeopleClient` folds both into `SyncTokenExpiredError`.
  `pageSize` max is 1000; the cache holds one row per (person, email),
  lowercased email for identity, original casing for display.

### OAuth

- The consent screen in Testing status issues refresh tokens that expire
  after seven days; Production needs Google's verification for the
  sensitive `contacts.*` scopes.
- Adding a scope later does not touch accounts already signed in: their
  tokens never carried it. Re-running **Add Google Account** for the same
  address re-consents and upgrades the account in place (`finishAddAccount`,
  case-insensitive on the email); a reconnect sends `login_hint`.

## Verified Apple Reminders (EventKit) semantics

- **Access**: `requestFullAccessToReminders` (macOS 14 / iOS 17+);
  `authorizationStatus(for: .reminder)` distinguishes fullAccess /
  writeOnly / denied / restricted / notDetermined. Access can be revoked
  in System Settings at any time — treat every pass's status check as the
  account's health, not the initial grant.
- **The helper is a bare executable**, so its usage strings ride in an
  embedded `__TEXT,__info_plist` (Package.swift `-sectcreate`); the app's
  Info.plist carries them too (forge `extendInfo`). Hardened runtime
  needs the Address Book and Calendars entitlements on the app and the
  helper even without App Sandbox.
- **Ids**: `calendarItemIdentifier` is stable enough for a mirror but can
  change after an iCloud sync — the snapshot reconciliation makes that a
  delete + reinsert, never a stale row. `calendarItemExternalIdentifier`
  is the portable key (the same on every device) and is what calendar
  mirrors use. Ids are server-assigned: no client-side idempotency trick,
  hence no queue. Deleting something Reminders.app already deleted
  answers notFound — treated as done.
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
- **Recurrence**: freq/interval/count|until, weekly by-day sets and one
  monthly ordinal ("2nd Tuesday", "last Friday") round-trip through
  `TaskRecurrence` (one `ByDay` type shared with events); the bridge
  reads a monthly ordinal whether EventKit stored it as the day's week
  number or as a set position and writes it as the week number. Yearly
  positional rules, several rules, day-of-month lists and a monthly rule
  on a plain weekday without an ordinal come back as `{ unsupported:
  true }`, the form shows them read-only, and writes never overwrite
  them.
- **Fetch**: one `predicateForReminders(in: nil)` — every reminder, open
  and completed, dated and undated. EventKit is local, so the fetch is
  cheap; the cost is the bridge payload on desktop, so `reminders.snapshot`
  returns all (listId, id) pairs plus full rows only for reminders whose
  `lastModifiedDate` ≥ `changedSince − 60 s` (re-reading the overlap is
  harmless — upserts apply only when strictly newer).
- **Change push**: `EKEventStoreChanged` fires for any EventKit change in
  any process (reminders and events alike), including our own
  write-throughs and iCloud bursts; the engine debounces it (1 s) and
  runs a reminders-only delta pass under the sync gate. It only reaches a
  live observer (the helper child can be respawned; iOS is suspended in
  the background), which is why the 90 s pass stays. EventKit posts it on
  the main queue, so the helper reads stdin on a background thread and
  keeps its main thread in `RunLoop.main.run()`.
- **Wire dates are Gregorian** whatever the device calendar; Foundation
  caches the system zone until it is reset, so the iOS module resets it
  on each foreground and the helper on each request.

## Apple Calendar (EventKit events) semantics

Designed from Apple's EventKit documentation; the real-EventKit CI spec
(`appleCalendarReal.e2e.ts`) asserts connect, change push, edit and
delete through the helper. Items marked _(verify)_ are not yet asserted
against a real store.

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
  EventKit, so a Google "calendar default" is resolved into explicit
  popups when an event is copied to an Apple calendar, and `useDefault`
  or an email reminder on an Apple event is refused with
  `UnsupportedForProviderError`.
- **Exchange** drops the URL field, which is why an Exchange calendar
  cannot be a mirror destination.

## Testing conventions

Email addresses in tests are made up: `@example.com`, the fixture
account's `@solunivo.test`, or one of Google's own formats
(`…@resource.calendar.google.com`, `…@group.calendar.google.com`) where
the shape matters. Never a real person's or domain's address. Nothing
needs one: the live suites take their account from `GOOGLE_LIVE_EMAIL`
and generate their guests (`guest-<runTag>@example.com`).

**Date-independence is a hard rule for every test involving "now"**:
inject the clock (`nowUtc` parameter) or build dates relative to today
with wall-clock times via Temporal in an explicit zone — never pinned
dates or UTC-offset literals. Three CI breakages came from tests that
passed on the day they were written and decayed. The desktop e2e seeds
place "today" by the UTC date (`todayAt`), which matches the local date
on CI (UTC) and in Vienna except between local midnight and 02:00 CEST —
a run in that window creates tasks on yesterday's column and fails
`convert` and the task editor test; rerun with `TZ=UTC` rather than
chasing a code bug.

### Unit tests (`vp test`, @effect/vitest)

- Layer recipe: `EventMutations.layer` + `reposLayer` +
  `Layer.effectDiscard(runMigrations)` +
  `SqliteClient.layer({ filename: ':memory:' })` + reactivity layer +
  `Layer.succeed(GoogleCalendarClient, stub)` (+
  `Layer.succeed(GoogleTasksClient, tasksStub)` where tasks are
  exercised). The stubbed client shapes are **complete records** — every
  new client method must be added to every stub (typecheck enumerates
  them).
- The engine reads `Clock`, and `it.effect` runs under `TestClock` —
  advance it between passes or `passStartedAt` never moves. Two-mutation
  queue tests pin the fiber yield point with the `noYield` helper (a
  migration can move it and flip the test).
- AI pipelines never hit a real model: the seams take a fake
  `LanguageModel`/`SpeechToText`/`TextRecognizer` returning canned JSON
  (`packages/ai/*.test.ts`). The e2e suites use the shared fixture model
  (`makeFixtureLanguageModel`, `fixtureTextRecognizer`): one event per
  line, `Title | +N or YYYY-MM-DD | HH:MM-HH:MM | Location`, with `+N`
  counted from the prompt's own "Today is" line so no spec computes a
  date; desktop `launchApp(seed, { model: 'fixture' })`, iOS
  `EXPO_PUBLIC_CALENDAR_MODEL=fixture` in the bundle (CI), which also
  accepts `solunivo-dev://capture-fixture?text=…` as a stand-in for a
  share.
- Apple Calendar never hits EventKit in tests: `makeFakeAppleCalendarClient`
  (`packages/apple-calendar/src/fake.ts`) keeps series the way EventKit
  does (master + rules, detached and deleted occurrences), expands them
  with core's expander and implements the span semantics above, so
  scope and move tests assert what EventKit "saw" via `fake.state`.
  Layer recipes that build `EventMutations` provide
  `appleCalendarServicesLayer(unavailableAppleCalendarClient('test'))`.
  The desktop e2e reuses the fake under `CALENDAR_APPLE_CALENDAR=fixture`.
- Reminders never hit EventKit in tests: `makeFakeRemindersClient`
  (`packages/reminders/src/fake.ts`) is an in-memory store with the
  bridge's semantics (server-assigned ids, null clears, list moves,
  switchable authorization); every other layer recipe provides
  `unavailableRemindersClient('test')`.
- `getWindow` joins visible calendars: tests asserting through it must
  seed a calendar row, not just events.
- A test is removed only when a surviving test asserts everything it did;
  regression and race tests stay even where they look alike. Dead code
  that only its own test called goes with it.

### The fake Google server

`packages/sync/src/testing/fakeGoogle.ts` is an in-process Calendar +
Tasks (+ People) API behind effect's `HttpClient`, and `engine.http.test.ts`
runs the real clients, request core and sync engine against it: full then
incremental passes with sync tokens, a 410 forcing a full resync whose
`deleteStale` drops vanished rows, cancelled tombstones, If-Match → 412
parking and both resolutions, client-generated event ids, the `updatedMin`
watermark with deleted task tombstones, server-assigned task ids, PATCH
merge and null-delete of private properties. The fake pages event lists
(`pageSize`, default 2,500; the sync token rides only on the last page)
and reports a removed calendar as a `deleted` calendarList entry on
incremental passes.

Both apps can run against the same fake (`testing/googleFixture.ts`):
desktop with `CALENDAR_GOOGLE=fixture` + `CALENDAR_GOOGLE_FIXTURE=<json>`
(the e2e harness's `google: { fixture }` launch option), iOS with
`EXPO_PUBLIC_CALENDAR_GOOGLE=fixture` at bundle time (CI does; the
fixture is `apps/ios/e2e/fixtures/google.ts`). A `GoogleFixture` names
accounts, calendars, task lists, tasks and People connections; only the
account rows are seeded locally, everything else arrives through the
first sync, and a pre-filled memory `TokenStore` keeps the real
`TokenManager` and request core on the path. The fake stamps writes with
the wall clock (`live`) so the device-time `updatedMin` watermark clears
them.

### Live Google suite (real account)

The fake pins what we _believe_ Google does; the live suite checks it
against Google itself, signed in as a dedicated throwaway account, at
three levels: the Node engine suite (`packages/sync/src/live/*.live.ts`
— the real clients, request core, `SyncEngine` and `EventMutations` over
`FetchHttpClient` with a fresh in-memory database per test), the desktop
spec `apps/desktop/e2e/googleLive.e2e.ts` and the iOS flows under
`apps/ios/e2e/live/`. None of them run in `pnpm test`, `pnpm test:e2e` or
`pnpm test:e2e:ios`: they need the token, they write to the account, and
they take minutes. `.github/workflows/google-live.yml` runs all three
nightly when `main` moved since the last completed run, on
`workflow_dispatch`, and on PRs labelled `google-live`, one run at a time
(`concurrency: google-live`). GitHub's `schedule` is best effort —
dispatch it by hand when a night is missing. What cannot be reached on
demand stays fake-only: 410 sync-token expiry, People
`EXPIRED_SYNC_TOKEN`, 403 insufficient scope, 429/5xx, paging, a
guest-side RSVP (needs a second account).

- **Setup (once).** A fresh Gmail account (sign into Calendar and Tasks
  once; unsubscribe the holiday calendars). The GCP project's OAuth
  consent screen must be **In production** (Testing tokens expire in
  seven days). Then `node scripts/google-live-token.mjs --write` — the
  desktop OAuth client, a loopback PKCE flow, the app's scopes plus the
  full `calendar` scope (calendars.insert/delete need it). It writes the
  gitignored `google-live.local.json` and prints the `gh secret set`
  lines for `GOOGLE_LIVE_EMAIL` and `GOOGLE_LIVE_REFRESH_TOKEN`; the
  workflow reuses `GOOGLE_DESKTOP_CLIENT_ID/SECRET` and fails red when
  any is missing. The refresh token is bound to the desktop client, so
  iOS refreshes it with that client too
  (`EXPO_PUBLIC_CALENDAR_GOOGLE_LIVE_CLIENT_ID/SECRET`).
- **Isolation.** Every run gets its own scratch calendars and task lists,
  named `e2e-<unixSeconds>-<runTag>[-suffix]` (`GOOGLE_LIVE_RUN_TAG` —
  `gh-<run>-<attempt>` on CI, `local-<pid>` locally), **one set per job**
  (Google caps calendar creation per day): the Node job's
  `live/globalSetup.ts` creates two calendars and two lists once and
  hands them to every file (`inject('liveScratch')`), the desktop spec
  and the iOS sidecar create one calendar and one list each; only
  `calendarList.live.ts` creates (and deletes) its own, since that is what
  it tests. Each job deletes its set at the end and first sweeps anything
  older than six hours that a crashed run left behind (`sweep`). Titles
  carry `live-<runTag>-…`; tests assert on their own ids and never touch
  the primary calendar. Guests are `guest-<runTag>@example.com` and every
  write with guests goes out with `sendUpdates=none`: `GuestNotifications`
  (`packages/google`, a `Context.Reference` defaulting to `'all'`) is
  `'none'` in the live layers only.
- **Recipe.** `packages/sync/src/testing/liveScratchRest.ts` is the
  admin side as plain `fetch` (no Effect, no workspace imports, so Node
  runs it unbundled): scratch calendars/lists, the sweep, and "the other
  device" — raw event/task writes without If-Match. `liveWire.ts` is the
  host half (`liveWireLayer`: `FetchHttpClient` + a memory `TokenStore`
  holding the refresh token with `expiresAt: 0`, so the very first
  request goes through the `TokenManager` refresh; `seedLiveAccount`) —
  free of Node imports so the iOS bundle can carry it. `liveGoogle.ts`
  adds the Effect `LiveScratch` service, `liveEngineLayer` and
  `makeScratchRuntime` for `beforeAll`/`afterAll`. Tests use `it.live`
  (real `Clock`); never `TestClock`. `vite.config.ts` switches on
  `GOOGLE_LIVE=1`: only `live/**/*.live.ts`, one file at a time, 120 s
  hooks, 300 s tests, no retry (a retry repeats real writes). `drain` in
  `live/support.ts` keeps draining until only parked ops are left and
  fails after two minutes, listing each op still queued.
- **Desktop.** `CALENDAR_GOOGLE=live` + `CALENDAR_GOOGLE_LIVE=<json>`
  (`{email, refreshToken, tasksEnabled, contactsEnabled}` — the harness
  writes it into the run's temp profile, mode 600, deleted with it) and
  `CALENDAR_SYNC_INTERVAL_MS` (the spec uses 10 s so a pull lands inside
  a poll). The spec always picks the run's own calendar and list — a new
  event defaults to the last-used or first writable calendar, which on a
  real account is the primary. For a 412 it fills the sheet first and
  patches Google just before Save (the app's own poll could otherwise
  refresh the etag and defuse the conflict), and retries the round when
  a poll still won. Run:
  `E2E=1 CALENDAR_E2E_GOOGLE=live pnpm exec vp test run apps/desktop/e2e/googleLive.e2e.ts`.
- **iOS.** Metro must start with `EXPO_PUBLIC_CALENDAR_GOOGLE=live`, the
  four `EXPO_PUBLIC_CALENDAR_GOOGLE_LIVE_*` values and
  `EXPO_PUBLIC_CALENDAR_SYNC_INTERVAL_MS=30000` (inlined at bundle
  time — CI and local only, never an EAS update). The sidecar
  `scripts/google-live-scratch.ts setup --suffix ios` sweeps, creates the
  run's calendar and list, mints a one-hour access token and exports
  them as `MAESTRO_LIVE_*` — the Maestro CLI injects every `MAESTRO_*`
  shell variable into each flow, and the refresh token never reaches
  Maestro. Maestro records every `MAESTRO_*` value, the token included, in
  each flow's `commands.json` and `maestro.log`, so a failed job's
  artifacts pass through `scripts/redact-live-reports.ts` first and the
  Maestro cache holds `~/.maestro/bin` and `lib` only. The flows
  (`e2e/live/flows/01…05`, tag `live`, outside `e2e/flows/` so the
  default suite never picks them up) run as explicit files in that
  order (`e2e/live/run.sh`); behind-the-back edits and Google-side
  checks are `runScript`s (`e2e/live/scripts/*.js`, GraalJS with `http`,
  `json`, `output`) polled through `wait-for-event*.yaml` /
  `wait-for-task.yaml`, paced by `scripts/pause.js` (a spin — GraalJS has
  no timers). Blocks are opened through `open-event.yaml`, calendar and
  list picked by their unique names through `pick-row.yaml`,
  `conflict-round.yaml` retries a round whose banner a poll defused.
  Maestro has no drag command, so 02 changes the event's shape through
  the all-day switch instead. Locally: `pnpm --filter @calendar/ios
  test:e2e:live` (dev client installed, Metro up with the live env;
  `SIMULATOR_UDID` picks the device).
- **Leaks.** Effect redacts `authorization` headers in logged causes; the
  desktop token file lives only in the temp profile; the iOS bundle on
  the CI simulator carries the secrets inlined (never shipped).

### Desktop e2e (`pnpm test:e2e`, apps/desktop/e2e/)

Raw CDP over Node's native WebSocket (no Playwright): the harness launches
the built Electron app with `--remote-debugging-port` and an isolated
`CALENDAR_USERDATA` profile, seeds SQLite through the app's own
migrations/repos, drives real input events, and asserts against both the
DOM and the database. Specs run with `retry: 1`, share one app instance
per file and run in file order — later tests must tolerate earlier
tests' data (relative assertions, unique titles). The harness always
sets `CALENDAR_REMINDERS=off`, `CALENDAR_CONTACTS=off`,
`CALENDAR_APPLE_CALENDAR=off`, `CALENDAR_GEO=off` and
`CALENDAR_NOTIFICATIONS=off`, points `CALENDAR_SETTINGS_FILE` and
`CALENDAR_AGENT_SOCKET` under the temp profile, and sets
`CALENDAR_E2E_INPUT=cdp`; `launchApp(seed, options)` opts a spec into a
fixture or a real bridge (`appleCalendar`, `contacts`, `geo`, `google`,
`model`, `reminders`, `agents`, `settingsFile`, `window`).

The specs: `flows` (rendering, views, trackpad pan, editor CRUD, drag
move/resize/cancel, slot drag, recurring scopes, RSVP, visibility,
calendar color, month view, task lane and editor, the sync footer, the
privacy modal, the settings window, the inspector and inline editor, ⌘K);
`capture` (paste-to-events on the fixture model); `reminders` and
`contacts` (seeded Apple/Google rows); `appleCalendar` (the in-memory
EventKit, read-only viewer, moves both ways); `location` (the picker and
map over the geo fixture); `birthdays` (device-contacts fixture, chip,
detail, device-only reminder settings); `eventReminders`; `timeZones`;
`settingsFile`; `mirrors`; `taskConvert` (Google writes left queued) and
`taskConvertGoogle` (the fake Google API, so pushes land); `convert`;
`conflicts` (seeded parked 412s resolved through the banner, plus the
notice stack at 1024 px and 600 px); `search`; `agentGateway` (seeded
agents, the built relay against the run's socket: CLI + MCP reads, a
write, refusals, the approval dialog, Settings → Agents); `remindersReal`
and `appleCalendarReal` (CI-only real-EventKit siblings, `describe.skipIf`
unless `CALENDAR_E2E_REMINDERS=real` / `CALENDAR_E2E_APPLE_CALENDAR=real`);
`googleLive` (opt-in, above).

Flakiness lessons (each caused a real CI failure — keep them enforced):

- **Integer coordinates only** for `Input.dispatchMouseEvent` — the app
  drops fractional positions as the OS cursor's. `Cdp.send` rounds them.
- **`scrollIntoView` before measuring** (harness `locate`): CI runners
  land the week grid at different scroll offsets.
- **The windows take CDP input only.** `CALENDAR_E2E_INPUT=cdp` opens
  them at the back without activating the app, ignores the OS mouse and
  drops the tracking-area enter/leave events macOS still sends;
  `Cdp.connect` turns on `Emulation.setFocusEmulationEnabled`, so the
  page acts as the focused window and keeps drawing while covered. A
  developer's keys and trackpad used to reach the test window (a Space
  opened the editor mid-drag, a moving trackpad dropped the capture).
  Consequence: `browser-window-focus` never fires in e2e, so no spec may
  count on the sync kick or the settings-file check it runs.
- **A window behind another one renders nothing** without that
  emulation: `cdp.waitForRendered` still draws a frame (a screenshot)
  before each try.
- **Weekday-agnostic seeding**: recurring seeds start `today − 3 days` and
  expectations derive from the first _visible_ instance.
- **Teardown**: await the Electron process `exit` (with timeout) before
  deleting the temp profile, and `rmSync` with retries.
- **Fire-and-forget UI mutations can silently drop**: poll for the effect
  and re-click after ~3s of no movement; assert relative change
  (`< before`), not exact counts.
- **A view shows the data, not a snapshot of it.** A click right after a
  write can open the inspector before the grid's refresh lands; the
  inspector follows its event, so no test waits for the refresh.
  Reproduce such races with the renderer throttled
  (`Emulation.setCPUThrottlingRate`, 6× or 12×) and never commit the
  throttle.
- **Measure layout only once the last write is drawn.** SQLite has a
  reminder's move before the all-day lane redraws it, and the lane's
  height moves the grid below it; a test whose successor measures
  geometry waits for its own result on screen.
- React inputs need the native value setter + `input`/`change` event
  dispatch; `<select>` likewise. The invitee combobox is driven through
  `input[aria-label="Invitees"]`, synthetic `keydown` for ArrowDown /
  Enter, `[role="option"]` rows and `[data-invitee]` chips.
- **Open items through the harness, locate by testid.** A grid click
  opens the inspector, not the editor: `cdp.openInspector(selector)` and
  `cdp.openEditor(selector)` (… → `inspector-edit` → `editor-title` reads
  "Edit event"); tasks and slots open the editor directly. Stable hooks:
  `toolbar-title`, `view-day/week/month`, `nav-prev/next`, `today`,
  `quick-add-input` / `quick-add-apply`, `find-time` and its
  `find-time-window/bounds/days/duration-*`, `find-time-search`,
  `find-time-slot-<n>` (the event form's finder), `mode-event/task/reminder` (a
  kind with nowhere to go is not rendered), `task-remove-due-date`,
  `sidebar`, `sync-footer`, `panel` (`data-panel-kind`), `inspector`,
  `editor`, `editor-notes`, `task-done`, `panel-task-<id>`,
  `week-scroller`, `week-grid`, `today-header`, `now-line`,
  `all-day-lane`, `month-grid`, and for search `search-toggle`,
  `search-input`, `search-results` (`aria-busy` "false" once the results
  answer the field's text), `search-group-upcoming|past|tasks`,
  `[data-search-result]` rows with `search-title` / `search-when` /
  `search-repeats`, `search-hint`, `search-empty`, `inspector-back`. A
  block's calendar color is its `data-color` attribute — never assert a
  computed color, the tint is theme-dependent — and Tailwind classes are
  not selectors. `[title^="…"]` matches grid blocks and chips only;
  completion is `[data-done]`, a block opened from a result
  `[data-selected]`. The settings window is a second CDP target
  (`app.openSettings(pane)` / `app.closeSettings()`).

### CI (.github/workflows/)

`ci.yml` on pushes to main and PRs; a `changes` job classifies the diff
(`desktop` / `ios` flags; docs-only skips every macOS job, `apps/ios/`
alone skips the desktop jobs, `apps/desktop/` or `packages/agent/` alone
skips the iOS shards) and the jobs carry `if:` guards — not
`paths-ignore`, which would leave required checks unreported. The macOS jobs wait for the gate, prefetch the
Electron binary (`electron --version`) and run spec files sequentially.

- `gate` (ubuntu, reusable `gate.yml`, also called by `ios.yml`): check +
  typecheck + unit tests. The check is "Gate / Lint, typecheck, unit tests".
- `e2e` (macos-15): desktop build → `pnpm test:e2e`.
- `e2e-reminders` (macos-26): the **real** EventKit path on the desktop.
  Builds the helper, seeds the runner's per-user TCC database
  (`apps/desktop/e2e/ci/grant-reminders-tcc.sh`, Reminders and
  Calendars; named columns, every plausible client identity), then
  `probe-helper-access.sh` requires `reminders.status` = fullAccess
  before `remindersReal` and `appleCalendarReal` run. The seed is not an
  Apple-supported interface: when a new runner image breaks it the job
  is red with tccd's own rows in the output — adjust the seed, never
  make the probe optional. Locally:
  `CALENDAR_E2E_REMINDERS=real E2E=1 pnpm exec vp test run apps/desktop/e2e/remindersReal.e2e.ts`
  (creates and deletes reminders in _your_ database).
- `ios-e2e-shards` (macos-26, two shards; the required check `ios-e2e`
  passes when the shards passed or were skipped): Maestro against an
  **EAS** build with the commit's JS embedded — no Metro, no dev
  launcher. `apps/ios/e2e/ci/fetch-eas-build.sh` looks up the
  `e2e-simulator` build for the commit's native fingerprint, requests one
  only if none exists (shard 1 only; shard 2 waits), and caches the
  extracted `.app` under `ios-e2e-app-<hash>`; `repack-app.sh` bundles
  the commit's JS (`@expo/repack-app --js-bundle-only`) into a copy,
  switches expo-updates off in its `Expo.plist` and re-signs it ad hoc;
  `EXPO_PUBLIC_CALENDAR_GOOGLE=fixture` and `…_MODEL=fixture` are inlined
  at that step. `prepare-simulator.sh boot` runs right after checkout (a
  runner's first boot spends two minutes in data migration) and
  `prepare-simulator.sh install` waits for it, installs, pre-grants
  Reminders, Calendars and Contacts with `simctl privacy grant`, and
  switches expo-dev-menu's floating button off. The whole job runs under
  `APP_VARIANT=development`. `shard-flows.mjs` splits every `ci` flow by
  position in the sorted file list (a new flow needs no registration);
  shard 1 first runs the permissions flow in its own Maestro invocation,
  since Maestro ignores `config.yaml` execution order. To reproduce a CI
  run locally: `eas build:list --build-profile e2e-simulator`,
  `fetch-eas-build.sh <fingerprint> e2e-simulator build/e2e-app`,
  `repack-app.sh`, a fresh simulator, then `maestro test` with the
  shard's files.
- `package-smoke` (macos-26, PRs only): unsigned `package:app`,
  packaged-contents assertions, `pnpm brand:check`, `solunivo-cli
  --version`.
- `testing-build` (macos-26, main only): signed + notarized arm64 zip
  incl. the Swift helper — macos-26 is the only runner image with the
  FoundationModels SDK. See docs/distribution.md.
- `ios.yml` (main + PRs): fingerprint-gated — TestFlight build when the
  native fingerprint changed, otherwise `eas update`; PRs get a `pr-<n>`
  preview channel.
- `google-live.yml` (nightly-if-changed, `workflow_dispatch`, the
  `google-live` PR label): `live-node` (ubuntu, `GOOGLE_LIVE=1`),
  `live-desktop` (macos-15, the one spec) and `live-ios` (macos-26: the
  dev client with Metro — the `development-simulator` profile fetched by
  fingerprint, the bootstrap flow — plus the sidecar's setup/teardown
  around the five flows).
- Log lines may stringify effect causes containing HTTP requests; effect
  redacts auth headers, so tokens cannot leak into CI logs this way.

### iOS e2e (Maestro, apps/ios/e2e/)

Text/testID-based flows under `flows/`, one per area rather than one per
check: each flow costs a launch and its setup, and the CI shards are
billed macOS minutes, so a new check joins the flow that already reaches
its screen. Flows carry `tags`: the ones CI shards are `ci`;
`00-devclient-bootstrap` (`ci-bootstrap`, the live job's dev-client
launch) and `04a-device-permissions` (`ci-permissions`) run as their own
steps and `pnpm test:e2e:ios` excludes them; `14-location` has no tag
(real MapKit needs the network) and runs only locally. Maestro runs a
directory's flows in a non-deterministic order, so every flow must be
independent of what ran before. Locally the flows run against the dev
client and Metro (`pnpm --filter @calendar/ios start`); the Google halves
are no-ops unless Metro was started with
`EXPO_PUBLIC_CALENDAR_GOOGLE=fixture`, and the Reminders flows (09, 17)
are no-ops until the simulator has a connected list — on CI, keyed on
the fixture account (`fixture@solunivo.test`, list "Mock Tasks", calendar
"Mock Calendar"), they connect Reminders themselves, write through real
EventKit and remove the account again. Maestro needs a JDK on PATH
(Apple's `/usr/bin/java` stub is not one; see AGENTS.md).

Shared subflows (`common/`): `launch.yaml` (every flow starts with it:
launch, recover the dev client if it fell back to the launcher, wait for
"Today", `waitForAnimationToEnd` — SafeAreaView applies the top inset a
beat after the first paint, so an earlier tap lands in the status bar),
`open-new-event.yaml` (the "+" → the editor on a new event, re-tapping
while the sheet is missing), `open-event-editor.yaml` (Edit on the detail
sheet a tap opens), `switch-view.yaml` (the header's menu, `VIEW`),
`switch-to-task.yaml`, `open-settings.yaml` (waits for `settings-root`),
`open-settings-page.yaml` (`PAGE`: `device`, `general`, `notifications`,
`file`, `advanced`, `mirrors`, `unsynced`; rows `settings-row-<page>`, pages
`settings-page-<page>`), `close-settings.yaml` (`BackButton` until the
root shows, then Done), `search-for.yaml` (`QUERY` typed into the Search
tab's system field until `RESULT` shows), `confirm-open.yaml` and
`await-shell.yaml` (the bootstrap flow's URL alert and shell wait).

Selector gotchas (each caused a real failure):

- Text selectors are **whole-string regexes**: prefix text does not
  match, regex metacharacters in titles must be escaped, and a pressable
  row reads as one element (title, subtitle and value together), so match
  with `.*` around the text. Decorative symbols stay out of labels
  (`Glyph`).
- A list row's label is title + swatch + check mark, so rows are picked
  by `id: task-list-option`; a chip body is tapped by its full text
  (`[0-9]+:[0-9]+ !!! <title>` for a timed reminder), because
  `.*<title>` also matches the checkbox's "Toggle <title>" label.
- Never select by `local-…` task ids (the op push swaps them to server
  ids mid-flow); avoid non-ASCII punctuation in typed text, and retype a
  title or address until the field holds all of it (XCTest garbles
  input, and Return on a partial address takes the top contact
  suggestion once 04a has left device Contacts connected on its shard).
- The kind control's segments are `mode-event` / `mode-task` /
  `mode-reminder` (a Reminders list sits behind `mode-reminder`, never in
  a task's list picker); a tap on an event opens its detail sheet first.
  Flows that open a sheet `waitForAnimationToEnd` before tapping inside
  it. Maestro's visibility ignores the keyboard and clipping: dismiss the
  keyboard before tapping a lower input, and a control clipped by a
  ScrollView edge counts as visible and swallows the tap (centre rows
  first, repeat the tap until its effect shows).
- The Search tab's field is found by its placeholder ("Events and
  tasks"); `hideKeyboard` cannot dismiss it — the field's "Close" ends
  the search. The detail sheet's own "Delete" stays in the tree behind
  the confirmation alert's, so the alert's is tapped `below:` its title.
- The quick-add flow accepts the field's "couldn't be read" outcome: a
  CI simulator passes the model availability check yet cannot generate
  without the fixture model, so the filled title is asserted only where
  a model answers.
- The bootstrap flow (live job only) `launchApp`s the dev client and only
  then opens `solunivo-dev://expo-development-client/?url=…`; it
  confirms exactly one "Open in Solunivo?" alert — every further "Open"
  re-delivered the URL mid-load and crashed the client — and its waits
  are `optional` so one slow attempt cannot end the flow early. On
  failure the job prints the simulator's crash report
  (`~/Library/Logs/DiagnosticReports/Solunivo-*.ips`).

Maestro has no reliable press-hold-drag command, so the flows check
timed/date-only editor transitions and unit tests cover the shared drag
math. Before claiming iOS reminder-drag coverage, check by hand on a
device with a connected Reminders list: in today's Day view create a
reminder due at 9:00, hold its title until it lifts, move it down one
hour and release — it must land at 10:00; reopen the editor, relaunch
the app, and confirm the time in Apple Reminders.
