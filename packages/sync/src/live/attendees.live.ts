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
import { bootstrap, hoursFromNow, pendingOps, titleFor, scratchFor, drain } from './support.ts';

/**
 * Guests on the real API, always with `sendUpdates=none` (GuestNotifications
 * is 'none' in the live layer; the guest is an example.com address that
 * Google never delivers to anyway): Google adds the organizer on insert,
 * an RSVP is an attendees-only PATCH without If-Match, a title-only edit
 * does not resend the guest list, and an empty list removes everyone.
 */

const config = liveGoogleConfigFromEnv();
const scratch = scratchFor(config);
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

describe('live Google: attendees', () => {
  it.live('a create with a guest: Google keeps the list as sent, the calendar organizes', () =>
    Effect.gen(function* () {
      // Verified 2026-09-24: an API insert does not add the organizer to
      // `attendees` (web UI inserts do) — on a secondary calendar the
      // organizer is the calendar itself, on the primary the account.
      const { mutations, scratch: google } = yield* bootstrap(config);
      const record = yield* mutations.createEvent(invite('invite'));
      yield* drain(mutations);
      const server = yield* google.getEvent(calendar(), record.id);
      expect(guestOf(server)?.responseStatus).toBe('needsAction');
      expect(server.attendees).toHaveLength(1);
      expect(server.organizer).toMatchObject({ email: calendar(), self: true });
      const row = yield* (yield* EventRepo).getById(LIVE_ACCOUNT_ID, calendar(), record.id);
      expect(row?.attendees?.map((attendee) => attendee.email)).toEqual([config.guestEmail]);
      expect(row?.attendees?.some((attendee) => attendee.isSelf)).toBe(false);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('the organizer cannot RSVP: not on the guest list, nothing is queued', () =>
    Effect.gen(function* () {
      // A guest-side RSVP (attendees-only PATCH without If-Match) needs a
      // second account to send the invitation — an invitation from the
      // account's own calendar never reaches its primary. The fake covers
      // that path (engine.http.test.ts); here Google's side is pinned.
      const { mutations } = yield* bootstrap(config);
      const record = yield* mutations.createEvent(invite('rsvp'));
      yield* drain(mutations);
      const outcome = yield* mutations
        .respondToEvent({
          accountId: LIVE_ACCOUNT_ID,
          calendarId: calendar(),
          eventId: record.id,
          response: 'tentative',
        })
        .pipe(
          Effect.map(() => 'responded'),
          Effect.catchTag('NotAttendeeError', () => Effect.succeed('not an attendee')),
        );
      expect(outcome).toBe('not an attendee');
      expect(yield* pendingOps).toEqual([]);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('a title-only edit keeps the guest list; an empty list removes the guest', () =>
    Effect.gen(function* () {
      const { mutations, scratch: google } = yield* bootstrap(config);
      const record = yield* mutations.createEvent(invite('guests'));
      yield* drain(mutations);
      yield* mutations.updateEvent({
        accountId: LIVE_ACCOUNT_ID,
        calendarId: calendar(),
        changes: { title: `${record.title} (edited)` },
        eventId: record.id,
      });
      yield* drain(mutations);
      expect(guestOf(yield* google.getEvent(calendar(), record.id))).toBeDefined();

      yield* mutations.updateEvent({
        accountId: LIVE_ACCOUNT_ID,
        calendarId: calendar(),
        changes: { attendees: [] },
        eventId: record.id,
      });
      yield* drain(mutations);
      expect(guestOf(yield* google.getEvent(calendar(), record.id))).toBeUndefined();
      expect(yield* pendingOps).toEqual([]);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );

  it.live('a content edit of an event with guests on a stale etag parks', () =>
    Effect.gen(function* () {
      const { mutations, scratch: google } = yield* bootstrap(config);
      const record = yield* mutations.createEvent(invite('stale'));
      yield* drain(mutations);
      yield* google.patchEvent(calendar(), record.id, { summary: `${record.title} (server)` });
      yield* mutations.updateEvent({
        accountId: LIVE_ACCOUNT_ID,
        calendarId: calendar(),
        changes: { title: `${record.title} (mine)` },
        eventId: record.id,
      });
      yield* drain(mutations);
      const [op] = yield* pendingOps;
      expect(op?.kind).toBe('update');
      expect(op?.conflictAt).toBeDefined();
      expect(op?.serverPayload?.title).toBe(`${record.title} (server)`);
    }).pipe(Effect.provide(liveEngineLayer(config))),
  );
});
