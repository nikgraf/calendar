import {
  EventReminders,
  eventsScope,
  GEO_PROPERTY_KEYS,
  GeoLocation,
  ReminderOverride,
} from '@calendar/core';
import { CalendarRepo, EventRepo, SyncStateRepo } from '@calendar/db';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vitest';
import {
  LIVE_ACCOUNT_ID,
  liveEngineLayer,
  liveGoogleConfigFromEnv,
} from '../testing/liveGoogle.ts';
import {
  bootstrap,
  deletedStatus,
  GONE,
  hoursFromNow,
  httpStatus,
  pendingOps,
  titleFor,
  scratchFor,
  drain,
} from './support.ts';

/**
 * Single events against the real Calendar API: the sync token, client
 * ids, etags, PATCH merge semantics, tombstones, extended properties,
 * reminders and calendar colours — every rule docs/google-sync-and-testing.md
 * states about them, checked against Google rather than the fake.
 */

const config = liveGoogleConfigFromEnv();
const scratch = scratchFor(config);
const calendar = () => scratch.calendars[0]!;

const timed = (name: string, hour: number, extra: Record<string, unknown> = {}) => ({
  accountId: LIVE_ACCOUNT_ID,
  calendarId: calendar(),
  endUtc: hoursFromNow(hour + 1),
  isAllDay: false,
  startTimeZone: 'Europe/Vienna',
  startUtc: hoursFromNow(hour),
  title: titleFor(config, name),
  ...extra,
});

/** `useDefault: false` with one popup — the shape the editor writes. */
const popup = (minutes: number) =>
  new EventReminders({
    overrides: [new ReminderOverride({ method: 'popup', minutes })],
    useDefault: false,
  });

describe('live Google: events', () => {
  it.live('the first pass stores the run calendar and leaves an events sync token', () =>
    Effect.gen(function* () {
      yield* bootstrap(config);
      const calendars = yield* (yield* CalendarRepo).list(LIVE_ACCOUNT_ID);
      const mine = calendars.find((entry) => entry.id === calendar());
      expect(mine?.accessRole).toBe('owner');
      const state = yield* (yield* SyncStateRepo).get(LIVE_ACCOUNT_ID, eventsScope(calendar()));
      expect(state?.status).toBe('idle');
      expect(state?.syncToken).toBeTruthy();
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('a local create posts its client id; the ack carries Google’s etag', () =>
    Effect.gen(function* () {
      const { mutations, scratch: google } = yield* bootstrap(config);
      const record = yield* mutations.createEvent(timed('create', 2));
      yield* drain(mutations);
      const server = yield* google.getEvent(calendar(), record.id);
      expect(server.summary).toBe(record.title);
      const row = yield* (yield* EventRepo).getById(LIVE_ACCOUNT_ID, calendar(), record.id);
      expect(row?.syncStatus).toBe('synced');
      expect(row?.etag).toBe(server.etag);
      expect(yield* pendingOps).toEqual([]);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('re-posting a client id Google already holds is a 409', () =>
    Effect.gen(function* () {
      // The drain reads a 409 on insert as "already landed" — this pins
      // that Google really answers 409, not 400 or 200.
      const { mutations, scratch: google } = yield* bootstrap(config);
      const record = yield* mutations.createEvent(timed('dup', 2));
      yield* drain(mutations);
      const outcome = yield* google
        .insertEvent(calendar(), {
          end: { dateTime: new Date(record.endUtc).toISOString() },
          id: record.id,
          start: { dateTime: new Date(record.startUtc).toISOString() },
          summary: record.title,
        })
        .pipe(
          Effect.map(() => 'inserted'),
          Effect.catchTag('LiveGoogleError', (error) =>
            Effect.succeed(`http ${httpStatus(error)}`),
          ),
        );
      expect(outcome).toBe('http 409');
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('an incremental pass applies a rename and a cancelled tombstone', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const kept = yield* mutations.createEvent(timed('kept', 2));
      const gone = yield* mutations.createEvent(timed('gone', 4));
      yield* drain(mutations);

      // Another device renames one and deletes the other.
      yield* google.patchEvent(calendar(), kept.id, { summary: `${kept.title} (renamed)` });
      yield* google.deleteEvent(calendar(), gone.id);
      yield* engine.syncAll();

      const events = yield* EventRepo;
      const keptRow = yield* events.getById(LIVE_ACCOUNT_ID, calendar(), kept.id);
      expect(keptRow?.title).toBe(`${kept.title} (renamed)`);
      expect(keptRow?.syncStatus).toBe('synced');
      expect(yield* events.getById(LIVE_ACCOUNT_ID, calendar(), gone.id)).toBeNull();
      const state = yield* (yield* SyncStateRepo).get(LIVE_ACCOUNT_ID, eventsScope(calendar()));
      expect(state?.status).toBe('idle');
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('a title-only patch leaves description and location alone', () =>
    Effect.gen(function* () {
      const { mutations, scratch: google } = yield* bootstrap(config);
      const record = yield* mutations.createEvent(
        timed('merge', 2, { description: 'Agenda: everything', location: 'Room 4' }),
      );
      yield* drain(mutations);
      yield* mutations.updateEvent({
        accountId: LIVE_ACCOUNT_ID,
        calendarId: calendar(),
        changes: { title: `${record.title} (edited)` },
        eventId: record.id,
      });
      yield* drain(mutations);
      const server = yield* google.getEvent(calendar(), record.id);
      expect(server.summary).toBe(`${record.title} (edited)`);
      expect(server.description).toBe('Agenda: everything');
      expect(server.location).toBe('Room 4');
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('a delete sends If-Match; Google answers cancelled afterwards', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const record = yield* mutations.createEvent(timed('delete', 2));
      yield* drain(mutations);
      yield* mutations.deleteEvent({
        accountId: LIVE_ACCOUNT_ID,
        calendarId: calendar(),
        eventId: record.id,
      });
      yield* drain(mutations);
      expect(yield* pendingOps).toEqual([]);
      expect(GONE.has(yield* deletedStatus(google, calendar(), record.id))).toBe(true);
      // The next pass carries the tombstone and does not resurrect the row.
      yield* engine.syncAll();
      expect(yield* (yield* EventRepo).getById(LIVE_ACCOUNT_ID, calendar(), record.id)).toBeNull();
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('coordinates ride in private extended properties and clear with the location', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      const location = 'Naschmarkt, Vienna, Austria';
      const geo = new GeoLocation({
        lat: 48.1977,
        lng: 16.3616,
        name: 'Naschmarkt',
        source: location,
      });
      const record = yield* mutations.createEvent(timed('geo', 2, { geo, location }));
      yield* drain(mutations);
      expect((yield* google.getEvent(calendar(), record.id)).extendedProperties?.private).toEqual({
        [GEO_PROPERTY_KEYS.coordinates]: '48.1977,16.3616',
        [GEO_PROPERTY_KEYS.name]: 'Naschmarkt',
        [GEO_PROPERTY_KEYS.source]: location,
      });

      // Another device reads them back.
      yield* engine.syncAll();
      const events = yield* EventRepo;
      expect((yield* events.getById(LIVE_ACCOUNT_ID, calendar(), record.id))?.geo).toEqual(geo);

      // An unrelated edit leaves the keys alone.
      yield* mutations.updateEvent({
        accountId: LIVE_ACCOUNT_ID,
        calendarId: calendar(),
        changes: { title: `${record.title} (late)` },
        eventId: record.id,
      });
      yield* drain(mutations);
      expect(
        (yield* google.getEvent(calendar(), record.id)).extendedProperties?.private,
      ).toMatchObject({ [GEO_PROPERTY_KEYS.source]: location });

      // A new location drops the coordinates: nulls delete the keys.
      yield* mutations.updateEvent({
        accountId: LIVE_ACCOUNT_ID,
        calendarId: calendar(),
        changes: { location: 'Office' },
        eventId: record.id,
      });
      yield* drain(mutations);
      const server = yield* google.getEvent(calendar(), record.id);
      expect(server.location).toBe('Office');
      expect(server.extendedProperties?.private?.[GEO_PROPERTY_KEYS.coordinates]).toBeUndefined();
      expect(server.extendedProperties?.private?.[GEO_PROPERTY_KEYS.source]).toBeUndefined();
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('reminder overrides are echoed back and replaced whole', () =>
    Effect.gen(function* () {
      const { mutations, scratch: google } = yield* bootstrap(config);
      const record = yield* mutations.createEvent(timed('reminders', 2, { reminders: popup(10) }));
      yield* drain(mutations);
      expect((yield* google.getEvent(calendar(), record.id)).reminders).toEqual({
        overrides: [{ method: 'popup', minutes: 10 }],
        useDefault: false,
      });

      yield* mutations.updateEvent({
        accountId: LIVE_ACCOUNT_ID,
        calendarId: calendar(),
        changes: { reminders: popup(25) },
        eventId: record.id,
      });
      yield* drain(mutations);
      expect((yield* google.getEvent(calendar(), record.id)).reminders?.overrides).toEqual([
        { method: 'popup', minutes: 25 },
      ]);

      // A title-only edit does not touch them.
      yield* mutations.updateEvent({
        accountId: LIVE_ACCOUNT_ID,
        calendarId: calendar(),
        changes: { title: `${record.title} (edited)` },
        eventId: record.id,
      });
      yield* drain(mutations);
      expect((yield* google.getEvent(calendar(), record.id)).reminders?.overrides).toEqual([
        { method: 'popup', minutes: 25 },
      ]);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('setCalendarColor patches the calendarList entry', () =>
    Effect.gen(function* () {
      const { engine, mutations, scratch: google } = yield* bootstrap(config);
      yield* mutations.setCalendarColor({
        accountId: LIVE_ACCOUNT_ID,
        calendarId: calendar(),
        colorHex: '#0b8043',
      });
      yield* drain(mutations);
      expect((yield* google.getCalendarListEntry(calendar())).backgroundColor?.toLowerCase()).toBe(
        '#0b8043',
      );
      yield* engine.syncAll();
      const calendars = yield* (yield* CalendarRepo).list(LIVE_ACCOUNT_ID);
      expect(calendars.find((entry) => entry.id === calendar())?.colorHex).toBe('#0b8043');
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );
});
