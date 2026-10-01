import { APPLE_CALENDAR_ACCOUNT_ID, plainDateToUtcMs } from '@calendar/core';
import { EventRepo, PendingOpRepo } from '@calendar/db';
import { expect, it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { describe } from 'vitest';
import type { EventDto } from './dto.ts';
import { callTool, decideRequest } from './gateway.ts';
import { createAgent } from './manage.ts';
import { type AgentPolicy, EMPTY_POLICY } from './policy.ts';
import { AgentRepo, AgentRequestRepo } from './store.ts';
import { activity, failureOf, untilAsked, watchApprovals } from './testing/calls.ts';
import {
  ACCOUNT,
  agentWith,
  appleDailySeries,
  appleSeriesStart,
  base,
  baseDate,
  DAY,
  grantCalendar,
  HOUR,
  iso,
  makeWorld,
  refs,
  seriesStart,
} from './testing/harness.ts';

/**
 * What an adversarial review of the gateway found, pinned: summaries
 * that hid or outlived what was written, recurring edits with the wrong
 * base, slots that do not exist, and requests answered too late.
 */

const writer = (overrides: Partial<AgentPolicy> = {}) =>
  agentWith({
    calendars: [
      grantCalendar('work', 'write'),
      grantCalendar('private', 'read'),
      grantCalendar('ek-home', 'write', APPLE_CALENDAR_ACCOUNT_ID),
    ],
    ...overrides,
  });

const stored = (policy: Partial<AgentPolicy>) =>
  Effect.map(createAgent('Hermes', { ...EMPTY_POLICY, ...policy }), ({ agent }) => agent);

/** Calendar writable, guests "ask": the natural "write, but ask before emailing people". */
const askGuests = { calendars: [grantCalendar('work', 'write')], guests: 'ask' as const };

const slot = seriesStart + 7 * DAY;
const weeklyRef = refs.occurrence('work', 'weekly', slot);
const master = Effect.gen(function* () {
  return (yield* (yield* EventRepo).getById(ACCOUNT, 'work', 'weekly'))!;
});

const eventsBetween = (agent: ReturnType<typeof agentWith>, from: number, to: number) =>
  Effect.map(
    callTool(agent, 'list_events', { from: iso(from), to: iso(to) }),
    (result) => (result as { events: ReadonlyArray<EventDto> }).events,
  );

describe('the approval summary is the whole write', () => {
  it.effect('every guest and every character of the text is shown — nothing is cut', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = yield* stored(askGuests);
      const asked = yield* watchApprovals;
      const guests = Array.from({ length: 12 }, (_, index) => ({
        email: `colleague${index}@corp.example`,
      }));
      const tail = 'THE PART THAT USED TO BE CUT OFF';
      yield* Effect.forkChild(
        callTool(agent, 'create_event', {
          attendees: [...guests, { email: 'outsider@evil.example' }],
          calendar: refs.calendar('work'),
          description: `${'Agenda. '.repeat(40)}${tail}`,
          start: iso(base + 18 * HOUR),
          title: `${'Planning '.repeat(15)}END-OF-TITLE`,
        }),
      );
      const { summary } = yield* untilAsked(asked);
      const text = [summary.title, ...summary.lines].join('\n');
      expect(text).toContain('outsider@evil.example');
      expect(text).toContain('colleague11@corp.example');
      expect(text).toContain(tail);
      expect(text).toContain('END-OF-TITLE');
      expect(text).not.toMatch(/…| more\b/u);
    }).pipe(Effect.provide(world.layer));
  });

  it.effect('a line break in agent text cannot pose as another line', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = yield* stored({ calendars: [grantCalendar('work', 'ask')] });
      const asked = yield* watchApprovals;
      yield* Effect.forkChild(
        callTool(agent, 'create_event', {
          calendar: refs.calendar('work'),
          description: 'Bring cake\nGuests: nobody at all‮',
          location: 'Room 1\r\nCalendar: Private',
          start: iso(base + 18 * HOUR),
          title: 'Party\nWhen: never',
        }),
      );
      const { summary } = yield* untilAsked(asked);
      expect(summary.title).toBe('Create event “Party ⏎ When: never”');
      expect(summary.lines.filter((line) => /^(Guests|Calendar|When):/u.test(line))).toEqual([
        'Calendar: Work (me@example.com)',
        expect.stringMatching(/^When: /u),
      ]);
      expect(summary.lines).toContain('Notes: Bring cake ⏎ Guests: nobody at all');
      expect(summary.lines).toContain('Location: Room 1 ⏎ Calendar: Private');
    }).pipe(Effect.provide(world.layer));
  });

  it.effect('adding a guest shows what that guest will receive', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = yield* stored(askGuests);
      yield* callTool(agent, 'update_event', {
        description: 'Quarterly numbers: confidential',
        location: 'Board room',
        ref: refs.event('work', 'standup'),
      });
      const asked = yield* watchApprovals;
      yield* Effect.forkChild(
        callTool(agent, 'update_event', {
          attendees: [{ email: 'x@evil.example' }],
          ref: refs.event('work', 'standup'),
        }),
      );
      const { summary } = yield* untilAsked(asked);
      expect(summary.lines).toEqual(
        expect.arrayContaining([
          'Location: Board room',
          'Notes: Quarterly numbers: confidential',
          'Adds Guests: x@evil.example',
        ]),
      );
    }).pipe(Effect.provide(world.layer));
  });

  it.effect('an approval does not cover a write that changed after it was asked', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = yield* stored(askGuests);
      const asked = yield* watchApprovals;
      const call = yield* Effect.forkChild(
        failureOf(
          callTool(agent, 'update_event', {
            attendees: [{ email: 'x@evil.example' }],
            ref: refs.event('work', 'standup'),
          }),
        ),
      );
      const request = yield* untilAsked(asked);
      expect(request.summary.title).toBe('Update event “Standup”');

      // While the user is looking at that, the same agent rewrites the
      // event — allowed on its own, since it has no guests yet.
      yield* callTool(agent, 'update_event', {
        description: 'text copied from a calendar the guest must not see',
        ref: refs.event('work', 'standup'),
        title: 'Therapy details',
      });

      expect(yield* decideRequest(request.id, 'approve')).toMatchObject({
        error: { message: expect.stringMatching(/changed after it was asked/u) },
        status: 'failed',
      });
      expect(yield* Fiber.join(call)).toMatchObject({
        _tag: 'Failed',
        message: expect.stringMatching(/Nothing was written/u),
      });
      const event = yield* (yield* EventRepo).getById(ACCOUNT, 'work', 'standup');
      expect(event?.attendees ?? []).toEqual([]);
    }).pipe(Effect.provide(world.layer));
  });

  it.effect('caps what an agent may send, and accepts only plain addresses', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = writer({ guests: 'allow' });
      const event = { calendar: refs.calendar('work'), start: iso(base + 18 * HOUR), title: 'T' };
      for (const bad of [
        { ...event, description: 'x'.repeat(8001) },
        { ...event, title: 'x'.repeat(501) },
        { ...event, location: 'x'.repeat(1001) },
        { ...event, attendees: [{ email: 'boss＠corp.example' }] },
        { ...event, attendees: [{ email: 'a@b.example​' }] },
        {
          ...event,
          attendees: Array.from({ length: 101 }, (_, index) => ({ email: `g${index}@b.example` })),
        },
        { ...event, recurrence: ['RRULE:FREQ=DAILY\nATTENDEE:mailto:x@evil.example'] },
        { ...event, recurrence: Array.from({ length: 11 }, () => 'RRULE:FREQ=DAILY') },
      ]) {
        expect((yield* failureOf(callTool(agent, 'create_event', bad)))._tag).toBe('InvalidInput');
      }
      expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
    }).pipe(Effect.provide(world.layer));
  });
});

/** Titles of the events that start at one instant. */
const titlesAt = (events: ReadonlyArray<EventDto>, start: number) =>
  events.filter((event) => Date.parse(event.start ?? '') === start).map((event) => event.title);

describe('recurring events', () => {
  it.effect('a series-wide change made from a moved occurrence does not drag the series', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = writer();
      // Move one occurrence on its own: 15:00–16:00 → 17:00–17:30.
      yield* callTool(agent, 'update_event', {
        end: iso(slot + 2.5 * HOUR),
        ref: weeklyRef,
        start: iso(slot + 2 * HOUR),
      });
      expect((yield* master).startUtc).toBe(seriesStart);

      // Now lengthen the whole series through that same occurrence.
      yield* callTool(agent, 'update_event', {
        end: iso(slot + 2 * HOUR),
        ref: weeklyRef,
        scope: 'series',
      });
      // The series still starts at 15:00 and now lasts two hours.
      expect(yield* master).toMatchObject({
        endUtc: seriesStart + 2 * HOUR,
        startUtc: seriesStart,
      });
    }).pipe(Effect.provide(world.layer));
  });

  it.effect(
    '"following" splits the series at the occurrence; earlier ones keep their title',
    () => {
      const world = makeWorld();
      return Effect.gen(function* () {
        const agent = writer();
        yield* callTool(agent, 'update_event', {
          ref: weeklyRef,
          scope: 'following',
          title: 'Weekly sync v2',
        });
        const events = yield* eventsBetween(agent, seriesStart - HOUR, slot + 8 * DAY);
        expect(titlesAt(events, seriesStart)).toEqual(['Weekly sync']);
        expect(titlesAt(events, slot)).toEqual(['Weekly sync v2']);
        expect(titlesAt(events, slot + 7 * DAY)).toEqual(['Weekly sync v2']);
      }).pipe(Effect.provide(world.layer));
    },
  );

  it.effect('an all-day series moves one occurrence at a time, never silently not at all', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = writer();
      const reviewSlot = plainDateToUtcMs(baseDate) + DAY;
      const ref = refs.occurrence('work', 'review', reviewSlot);
      for (const scope of ['series', 'following'] as const) {
        expect(
          yield* failureOf(
            callTool(agent, 'update_event', { ref, scope, startDate: '2030-01-01' }),
          ),
        ).toMatchObject({
          _tag: 'InvalidInput',
          message: expect.stringMatching(/one occurrence at a time/u),
        });
      }
      expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      // Non-time fields still apply series-wide, and one occurrence can move.
      yield* callTool(agent, 'update_event', { ref, scope: 'series', title: 'Review day' });
      yield* callTool(agent, 'update_event', { ref, startDate: '2030-01-01' });
      const overrides = yield* (yield* EventRepo).listOverrides(ACCOUNT, 'work', 'review');
      expect(overrides).toMatchObject([{ originalStartUtc: reviewSlot, startDate: '2030-01-01' }]);
    }).pipe(Effect.provide(world.layer));
  });

  it.effect('a slot the series does not have is not an occurrence', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = writer();
      const events = yield* EventRepo;
      // A made-up slot, and an occurrence ref on an event that does not repeat.
      for (const ref of [
        refs.occurrence('work', 'weekly', slot + 1000),
        refs.occurrence('work', 'weekly', slot + DAY),
        refs.occurrence('work', 'standup', base + 10 * HOUR),
      ]) {
        expect(
          yield* failureOf(callTool(agent, 'update_event', { ref, title: 'Phantom' })),
        ).toMatchObject({ _tag: 'NotFound', what: 'Event' });
        expect((yield* failureOf(callTool(agent, 'delete_event', { ref })))._tag).toBe('NotFound');
      }
      expect(yield* events.listOverrides(ACCOUNT, 'work', 'weekly')).toEqual([]);
      expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);

      // A deleted occurrence is gone for good.
      yield* callTool(agent, 'delete_event', { ref: weeklyRef });
      expect(
        (yield* failureOf(callTool(agent, 'update_event', { ref: weeklyRef, title: 'Back' })))._tag,
      ).toBe('NotFound');
    }).pipe(Effect.provide(world.layer));
  });

  it.effect(
    'Apple: an occurrence that was moved is edited as it is now, not as the series began',
    () => {
      const world = makeWorld({ appleEvents: [appleDailySeries] });
      return Effect.gen(function* () {
        const agent = writer();
        const day2 = appleSeriesStart + DAY;
        const ref = refs.occurrence('ek-home', 'ek-walk', day2, APPLE_CALENDAR_ACCOUNT_ID);
        // Detach day 2: 20:00–21:00 → 22:00–22:30, renamed.
        yield* callTool(agent, 'update_event', {
          end: iso(day2 + 2.5 * HOUR),
          ref,
          start: iso(day2 + 2 * HOUR),
          title: 'Late walk',
        });
        const detached = () => world.apple.state.series.get('ek-walk')?.detached.get(day2);
        expect(detached()).toMatchObject({ startUtc: day2 + 2 * HOUR, title: 'Late walk' });

        // "A lone end keeps the start" — the occurrence's own 22:00, not the series' 20:00.
        yield* callTool(agent, 'update_event', { end: iso(day2 + 3 * HOUR), ref });
        expect(detached()).toMatchObject({ endUtc: day2 + 3 * HOUR, startUtc: day2 + 2 * HOUR });

        // An approval names the occurrence the write lands on.
        const asker = yield* stored({
          calendars: [grantCalendar('ek-home', 'ask', APPLE_CALENDAR_ACCOUNT_ID)],
        });
        const asked = yield* watchApprovals;
        yield* Effect.forkChild(callTool(asker, 'delete_event', { ref }));
        expect((yield* untilAsked(asked)).summary.title).toBe('Delete event “Late walk”');

        // A slot the series does not have, and a slot on an event that does not repeat.
        for (const bad of [
          refs.occurrence('ek-home', 'ek-walk', day2 + 1000, APPLE_CALENDAR_ACCOUNT_ID),
          refs.occurrence('ek-home', 'ek-dentist', base + 8 * HOUR, APPLE_CALENDAR_ACCOUNT_ID),
        ]) {
          expect((yield* failureOf(callTool(agent, 'delete_event', { ref: bad })))._tag).toBe(
            'NotFound',
          );
        }
        expect(world.apple.state.series.has('ek-dentist')).toBe(true);
      }).pipe(Effect.provide(world.layer));
    },
  );
});

describe('grants, again', () => {
  it.effect(
    "Google: a ref pairing a granted calendar with another calendar's event is refused",
    () => {
      const world = makeWorld();
      return Effect.gen(function* () {
        const agent = writer();
        // "therapy" lives in the read-only "private" calendar.
        const forged = refs.event('work', 'therapy');
        expect((yield* failureOf(callTool(agent, 'delete_event', { ref: forged })))._tag).toBe(
          'NotFound',
        );
        expect(
          (yield* failureOf(callTool(agent, 'update_event', { ref: forged, title: 'x' })))._tag,
        ).toBe('NotFound');
        // Its honest ref is readable but not writable.
        expect(
          yield* failureOf(
            callTool(agent, 'delete_event', { ref: refs.event('private', 'therapy') }),
          ),
        ).toMatchObject({ _tag: 'PermissionDenied', reason: 'level' });
        expect((yield* (yield* EventRepo).getById(ACCOUNT, 'private', 'therapy'))?.title).toBe(
          'Therapy',
        );
      }).pipe(Effect.provide(world.layer));
    },
  );

  it.effect('an RSVP answers for the user and needs only the calendar level', () => {
    const world = makeWorld({ appleEvents: [appleDailySeries] });
    return Effect.gen(function* () {
      const agent = writer();
      yield* callTool(agent, 'respond_to_event', {
        ref: refs.event('work', 'declined'),
        response: 'accepted',
      });
      const event = yield* (yield* EventRepo).getById(ACCOUNT, 'work', 'declined');
      expect(event?.attendees?.find((attendee) => attendee.isSelf)?.responseStatus).toBe(
        'accepted',
      );
      expect((yield* (yield* PendingOpRepo).listAll()).map((op) => op.kind)).toEqual(['rsvp']);

      // Not on the guest list; read-only grant; Apple has no RSVP.
      expect(
        (yield* failureOf(
          callTool(agent, 'respond_to_event', {
            ref: refs.event('work', 'standup'),
            response: 'accepted',
          }),
        ))._tag,
      ).toBe('InvalidInput');
      expect(
        (yield* failureOf(
          callTool(agent, 'respond_to_event', {
            ref: refs.event('private', 'therapy'),
            response: 'declined',
          }),
        ))._tag,
      ).toBe('PermissionDenied');
      expect(
        (yield* failureOf(
          callTool(agent, 'respond_to_event', {
            ref: refs.event('ek-home', 'ek-dentist', APPLE_CALENDAR_ACCOUNT_ID),
            response: 'accepted',
          }),
        ))._tag,
      ).toBe('Unsupported');
    }).pipe(Effect.provide(world.layer));
  });
});

describe('requests', () => {
  it.effect('a request older than a day cannot be approved any more', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = yield* stored({ calendars: [grantCalendar('work', 'ask')] });
      const asked = yield* watchApprovals;
      yield* Effect.forkChild(
        callTool(agent, 'create_event', {
          calendar: refs.calendar('work'),
          start: iso(base + 18 * HOUR),
          title: 'Too late',
        }),
      );
      const request = yield* untilAsked(asked);
      yield* TestClock.adjust('25 hours');
      expect(yield* decideRequest(request.id, 'approve')).toMatchObject({ status: 'expired' });
      expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      // The agent learns it from get_request.
      expect(yield* callTool(agent, 'get_request', { requestId: request.id })).toMatchObject({
        status: 'expired',
      });
    }).pipe(Effect.provide(world.layer));
  });

  it.effect(
    'approving for an agent that no longer exists fails the request, and it settles',
    () => {
      const world = makeWorld();
      return Effect.gen(function* () {
        const agent = yield* stored({ calendars: [grantCalendar('work', 'ask')] });
        const asked = yield* watchApprovals;
        const call = yield* Effect.forkChild(
          failureOf(
            callTool(agent, 'create_event', {
              calendar: refs.calendar('work'),
              start: iso(base + 18 * HOUR),
              title: 'Orphan',
            }),
          ),
        );
        const request = yield* untilAsked(asked);
        // The row vanishes without the tidy-up removeAgent does.
        yield* (yield* AgentRepo).remove(agent.id);
        expect(yield* decideRequest(request.id, 'approve')).toMatchObject({
          error: { message: 'The agent that asked for this was removed.' },
          status: 'failed',
        });
        // The waiting call was woken, not left hanging.
        expect((yield* Fiber.join(call))._tag).toBe('Failed');
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      }).pipe(Effect.provide(world.layer));
    },
  );

  it.effect('the log keeps summaries, not inputs — settled requests included', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const direct = writer();
      yield* callTool(direct, 'create_event', {
        calendar: refs.calendar('work'),
        description: 'private notes',
        start: iso(base + 18 * HOUR),
        title: 'Logged',
      });
      yield* failureOf(
        callTool(direct, 'create_event', {
          calendar: refs.calendar('private'),
          description: 'x'.repeat(5000),
          start: iso(base + 18 * HOUR),
          title: 'Refused',
        }),
      );
      const asker = yield* stored({ calendars: [grantCalendar('work', 'ask')] });
      const asked = yield* watchApprovals;
      yield* Effect.forkChild(
        callTool(asker, 'create_event', {
          calendar: refs.calendar('work'),
          start: iso(base + 19 * HOUR),
          title: 'Asked',
        }),
      );
      const request = yield* untilAsked(asked);
      const requests = yield* AgentRequestRepo;
      // Needed to replay while it waits …
      expect((yield* requests.get(request.id))?.input).toMatchObject({ title: 'Asked' });
      yield* decideRequest(request.id, 'approve');
      // … and gone once it is settled.
      // (All rows share the test clock's instant, so their order is not asserted.)
      const rows = yield* activity;
      expect(rows.map((row) => [row.summary.title, row.status, row.input]).sort()).toEqual([
        ['Create event “Asked”', 'done', null],
        ['Create event “Logged”', 'done', null],
        ['Create event “Refused”', 'blocked', null],
      ]);
    }).pipe(Effect.provide(world.layer));
  });
});
