import { EventRepo } from '@calendar/db';
import { expect, it } from '@effect/vitest';
import { Effect } from 'effect';
import { describe } from 'vitest';
import {
  LIVE_ACCOUNT_ID,
  type LiveEvent,
  liveEngineLayer,
  liveGoogleConfigFromEnv,
} from '../testing/liveGoogle.ts';
import { bootstrap, hoursFromNow, pendingOps, titleFor, scratchFor } from './support.ts';

/**
 * Guests on the real API, always with `sendUpdates=none` (GuestNotifications
 * is 'none' in the live layer; the guest is an example.com address that
 * Google never delivers to anyway): Google adds the organizer on insert,
 * an RSVP is an attendees-only PATCH without If-Match, a title-only edit
 * does not resend the guest list, and an empty list removes everyone.
 */

const config = liveGoogleConfigFromEnv();
const scratch = scratchFor(config, { calendars: ['attendees'] });
const calendar = () => scratch.calendars[0]!;

const invite = (name: string) => ({
  accountId: LIVE_ACCOUNT_ID,
  attendees: [{ email: config.guestEmail }],
  calendarId: calendar(),
  endUtc: hoursFromNow(3),
  isAllDay: false,
  startTimeZone: 'Europe/Vienna',
  startUtc: hoursFromNow(2),
  title: titleFor(config, name),
});

const guestOf = (event: LiveEvent) =>
  event.attendees?.find((attendee) => attendee.email === config.guestEmail);
const organizerOf = (event: LiveEvent) =>
  event.attendees?.find((attendee) => attendee.self === true);

describe('live Google: attendees', () => {
  it.live('a create with a guest comes back with the organizer added', () =>
    Effect.gen(function* () {
      const { mutations, scratch: google } = yield* bootstrap(config);
      const record = yield* mutations.createEvent(invite('invite'));
      yield* mutations.processPendingOps();
      const server = yield* google.getEvent(calendar(), record.id);
      expect(guestOf(server)?.responseStatus).toBe('needsAction');
      expect(organizerOf(server)?.organizer).toBe(true);
      const row = yield* (yield* EventRepo).getById(LIVE_ACCOUNT_ID, calendar(), record.id);
      expect(row?.attendees?.some((attendee) => attendee.isSelf)).toBe(true);
      expect(row?.attendees?.some((attendee) => attendee.email === config.guestEmail)).toBe(true);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('an RSVP patches only the own attendee, without If-Match', () =>
    Effect.gen(function* () {
      const { mutations, scratch: google } = yield* bootstrap(config);
      const record = yield* mutations.createEvent(invite('rsvp'));
      yield* mutations.processPendingOps();
      // Google moves on behind our back; the RSVP still lands (no If-Match).
      yield* google.patchEvent(calendar(), record.id, { summary: `${record.title} (server)` });
      yield* mutations.respondToEvent({
        accountId: LIVE_ACCOUNT_ID,
        calendarId: calendar(),
        eventId: record.id,
        response: 'tentative',
      });
      yield* mutations.processPendingOps();
      expect(yield* pendingOps).toEqual([]);
      const server = yield* google.getEvent(calendar(), record.id);
      expect(organizerOf(server)?.responseStatus).toBe('tentative');
      expect(guestOf(server)?.responseStatus).toBe('needsAction');
      expect(server.summary).toBe(`${record.title} (server)`);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('a title-only edit keeps the guest list; an empty list removes the guest', () =>
    Effect.gen(function* () {
      const { mutations, scratch: google } = yield* bootstrap(config);
      const record = yield* mutations.createEvent(invite('guests'));
      yield* mutations.processPendingOps();
      yield* mutations.updateEvent({
        accountId: LIVE_ACCOUNT_ID,
        calendarId: calendar(),
        changes: { title: `${record.title} (edited)` },
        eventId: record.id,
      });
      yield* mutations.processPendingOps();
      expect(guestOf(yield* google.getEvent(calendar(), record.id))).toBeDefined();

      yield* mutations.updateEvent({
        accountId: LIVE_ACCOUNT_ID,
        calendarId: calendar(),
        changes: { attendees: [] },
        eventId: record.id,
      });
      yield* mutations.processPendingOps();
      expect(guestOf(yield* google.getEvent(calendar(), record.id))).toBeUndefined();
      expect(yield* pendingOps).toEqual([]);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('a content edit on a stale etag parks where the RSVP went through', () =>
    Effect.gen(function* () {
      const { mutations, scratch: google } = yield* bootstrap(config);
      const record = yield* mutations.createEvent(invite('stale'));
      yield* mutations.processPendingOps();
      yield* google.patchEvent(calendar(), record.id, { summary: `${record.title} (server)` });
      yield* mutations.updateEvent({
        accountId: LIVE_ACCOUNT_ID,
        calendarId: calendar(),
        changes: { title: `${record.title} (mine)` },
        eventId: record.id,
      });
      yield* mutations.processPendingOps();
      const [op] = yield* pendingOps;
      expect(op?.kind).toBe('update');
      expect(op?.conflictAt).toBeDefined();
      expect(op?.serverPayload?.title).toBe(`${record.title} (server)`);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );
});
