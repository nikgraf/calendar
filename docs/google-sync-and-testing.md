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
- **412 (etag mismatch)**: we use If-Match on content updates/deletes when
  an etag is known; on 412 the server wins (drop op, toast, next pull
  replaces local).

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

- Meeting links: `hangoutLink`, else `conferenceData.entryPoints[]` with
  `entryPointType === 'video'`; `meetingUrl()` in core also scans
  location/description for Meet/Zoom/Teams/Webex/Whereby URLs.
- Sync: incremental via syncTokens; 410 → drop token, full resync,
  `deleteStale`. The special birthday/holiday calendars flow through the
  normal calendarList.
- **Google Tasks** (planned feature) is a separate API with no syncTokens
  (poll `updatedMin`), date-only `due` values, and **no recurrence
  exposure** — Google materializes the next occurrence of a repeating task
  when the current one completes.

## Testing conventions

### Unit tests (`vp test`, @effect/vitest)

- Layer recipe: `EventMutations.layer` + `reposLayer` +
  `Layer.effectDiscard(runMigrations)` +
  `SqliteClient.layer({ filename: ':memory:' })` + reactivity layer +
  `Layer.succeed(GoogleCalendarClient, stub)`.
- The stubbed `GoogleCalendarClientShape` is a **complete record** — every
  new client method must be added to every stub (typecheck enumerates
  them).
- `getWindow` joins visible calendars: tests asserting through it must
  seed a calendar row, not just events.
- Tests run on Node against `better-sqlite3-node` (vite alias); the app's
  root `better-sqlite3` stays Electron-ABI.

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

### CI (.github/workflows/ci.yml)

- `gate` (ubuntu): check + typecheck + unit tests.
- `e2e` (macos-14): `rebuild:native` → desktop build → e2e suite. GUI
  Electron runs fine on macOS runners; content protection does not affect
  CDP automation.

### iOS e2e (Maestro, apps/ios/e2e/flows/)

Text/testID-based flows (launch, navigation, editor, settings). Maestro
cannot synthesize long-press pans, so gesture behavior is covered by unit
tests on the shared math instead.
