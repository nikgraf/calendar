import { APPLE_CALENDAR_ACCOUNT_ID, APPLE_REMINDERS_ACCOUNT_ID } from '@calendar/core';
import { EventRepo, PendingOpRepo, TaskRepo } from '@calendar/db';
import { expect, it } from '@effect/vitest';
import { Effect, Fiber } from 'effect';
import { TestClock } from 'effect/testing';
import { describe } from 'vite-plus/test';
import type { CalendarDto, EventDto, TaskDto } from './dto.ts';
import { callTool, decideRequest, MAX_PENDING_PER_AGENT } from './gateway.ts';
import { createAgent, removeAgent, updateAgent } from './manage.ts';
import { EMPTY_POLICY } from './policy.ts';
import type { AgentRecord } from './store.ts';
import { activity, failureOf, untilAsked, watchApprovals } from './testing/calls.ts';
import {
  ACCOUNT,
  agentWith,
  base,
  baseDate,
  DAY,
  grantCalendar,
  grantList,
  HOUR,
  iso,
  makeWorld,
  refs,
  seriesStart,
} from './testing/harness.ts';

const range = { from: iso(base), to: iso(base + DAY) };

/** A time on the base day as the gateway prints it in the (UTC) primary zone. */
const at = (hours: number) => iso(base + hours * HOUR).replace('Z', '+00:00');

const titles = (result: unknown): Array<string> =>
  (result as { events: ReadonlyArray<EventDto> }).events.map((event) => event.title);

const eventsOf = (result: unknown): ReadonlyArray<EventDto> =>
  (result as { events: ReadonlyArray<EventDto> }).events;

const reader = () =>
  agentWith({
    calendars: [
      grantCalendar('work', 'read'),
      grantCalendar('private', 'freeBusy'),
      grantCalendar('team', 'write'),
      grantCalendar('hidden', 'write'),
      grantCalendar('ek-home', 'read', APPLE_CALENDAR_ACCOUNT_ID),
    ],
  });

describe('reads', () => {
  it.effect('lists only granted, visible calendars — with level and real writability', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const result = (yield* callTool(reader(), 'list_calendars', {})) as {
        calendars: ReadonlyArray<CalendarDto>;
      };
      expect(
        result.calendars.map((calendar) => [calendar.name, calendar.access, calendar.writable]),
      ).toEqual([
        ['Private', 'freeBusy', false],
        // A write grant on a calendar the provider keeps read-only cannot write.
        ['Team (read-only)', 'write', false],
        ['Work', 'read', false],
        ['Home', 'read', false],
      ]);
      expect(result.calendars.find((calendar) => calendar.name === 'Home')).toMatchObject({
        account: 'Apple Calendar',
        provider: 'apple',
      });
      // Hidden in the app = not there for agents, even with a write grant; "Secret" has no grant.
      expect(JSON.stringify(result)).not.toMatch(/Hidden|Secret/u);
    }).pipe(Effect.provide(world.layer));
  });

  it.effect('a new agent sees nothing at all', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const nobody = agentWith({});
      expect(yield* callTool(nobody, 'list_calendars', {})).toEqual({ calendars: [] });
      expect(yield* callTool(nobody, 'list_task_lists', {})).toEqual({ taskLists: [] });
      expect(titles(yield* callTool(nobody, 'list_events', range))).toEqual([]);
      expect(yield* callTool(nobody, 'get_free_busy', range)).toMatchObject({ busy: [] });
      expect(yield* callTool(nobody, 'list_tasks', { fromDate: baseDate })).toEqual({ tasks: [] });
    }).pipe(Effect.provide(world.layer));
  });

  it.effect('events come only from calendars readable in full, Apple ones included', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const result = yield* callTool(reader(), 'list_events', range);
      expect(titles(result)).toEqual([
        'Dentist',
        'Standup',
        'Lunch with Ana',
        'Team offsite',
        'Weekly sync',
        'Vendor pitch',
      ]);
      // Free/busy-only, ungranted and hidden calendars leak nothing.
      expect(JSON.stringify(result)).not.toMatch(/Therapy|Secret plan|Hidden thing/u);
      const weekly = eventsOf(result).find((event) => event.title === 'Weekly sync');
      expect(weekly).toMatchObject({
        end: iso(base + 16 * HOUR).replace('Z', '+00:00'),
        recurring: true,
        start: iso(base + 15 * HOUR).replace('Z', '+00:00'),
      });
      expect(weekly?.ref).toBe(refs.occurrence('work', 'weekly', seriesStart + 7 * DAY));
    }).pipe(Effect.provide(world.layer));
  });

  it.effect('filters by calendar and text, and caps the result', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = reader();
      expect(
        titles(
          yield* callTool(agent, 'list_events', { ...range, calendars: [refs.calendar('team')] }),
        ),
      ).toEqual(['Team offsite']);
      expect(titles(yield* callTool(agent, 'list_events', { ...range, query: 'ANA@' }))).toEqual([
        'Lunch with Ana',
      ]);
      // Naming a free/busy-only calendar yields no details either.
      expect(
        titles(
          yield* callTool(agent, 'list_events', {
            ...range,
            calendars: [refs.calendar('private')],
          }),
        ),
      ).toEqual([]);
      const capped = yield* callTool(agent, 'list_events', { ...range, limit: 2 });
      expect(titles(capped)).toHaveLength(2);
      expect(capped).toMatchObject({ truncated: true });
      // A calendar the agent has no grant for does not exist.
      const missing = yield* failureOf(
        callTool(agent, 'list_events', {
          ...range,
          calendars: [refs.calendar('nope')],
        }),
      );
      expect(missing._tag).toBe('NotFound');
    }).pipe(Effect.provide(world.layer));
  });

  it.effect('free/busy merges across calendars and carries no details', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const result = yield* callTool(reader(), 'get_free_busy', range);
      expect(result).toEqual({
        busy: [
          { end: at(9), start: at(8) },
          // Standup 10–11 (work) and Therapy 10:30–11:30 (free/busy only) are one block.
          { end: at(11.5), start: at(10) },
          { end: at(13), start: at(12) },
          { end: at(16), start: at(14) },
          // The declined 16:00 pitch blocks nothing.
        ],
        timeZone: 'UTC',
      });
    }).pipe(Effect.provide(world.layer));
  });

  it.effect('free slots avoid busy time from free/busy-only calendars too', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const result = (yield* callTool(reader(), 'find_free_slots', {
        durationMinutes: 60,
        earliestTime: '10:00',
        fromDate: baseDate,
        latestTime: '14:00',
        toDate: baseDate,
      })) as { slots: ReadonlyArray<{ start: string }> };
      // 10:00–11:30 is taken (the last half hour only by the free/busy calendar), 12–13 by lunch.
      expect(result.slots.map((slot) => slot.start.slice(11, 16))).toEqual(['13:00']);
    }).pipe(Effect.provide(world.layer));
  });

  it.effect('tasks follow the list grant; contacts need their own switch', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = agentWith({ taskLists: [grantList('list-a', 'read')] });
      const result = (yield* callTool(agent, 'list_tasks', { fromDate: baseDate })) as {
        tasks: ReadonlyArray<TaskDto>;
      };
      expect(result.tasks.map((task) => task.title)).toEqual(['Call mom']);
      expect(result.tasks[0]?.ref).toBe(refs.task('list-a', 'rem-a'));

      const denied = yield* failureOf(callTool(agent, 'search_contacts', { query: 'ana' }));
      expect(denied).toMatchObject({ _tag: 'PermissionDenied', reason: 'contacts' });
      expect(
        yield* callTool(agentWith({ contacts: true }), 'search_contacts', { query: 'ana' }),
      ).toEqual({ contacts: [] });
    }).pipe(Effect.provide(world.layer));
  });

  it.effect('rejects unknown tools, unknown fields and oversized ranges', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = reader();
      expect((yield* failureOf(callTool(agent, 'drop_tables', {})))._tag).toBe('InvalidInput');
      expect(
        (yield* failureOf(callTool(agent, 'list_events', { ...range, calender: 'typo' })))._tag,
      ).toBe('InvalidInput');
      expect(
        (yield* failureOf(
          callTool(agent, 'list_events', { from: iso(base), to: iso(base + 500 * DAY) }),
        ))._tag,
      ).toBe('InvalidInput');
      expect(
        (yield* failureOf(callTool(agent, 'list_events', { from: iso(base), to: iso(base) })))._tag,
      ).toBe('InvalidInput');
    }).pipe(Effect.provide(world.layer));
  });
});

const writer = (overrides: Parameters<typeof agentWith>[0] = {}) =>
  agentWith({
    calendars: [
      grantCalendar('work', 'write'),
      grantCalendar('private', 'read'),
      grantCalendar('team', 'write'),
      grantCalendar('ek-home', 'write', APPLE_CALENDAR_ACCOUNT_ID),
    ],
    taskLists: [
      grantList('list-a', 'write'),
      grantList('list-ro', 'write'),
      grantList('tl-1', 'write', ACCOUNT),
    ],
    ...overrides,
  });

const newEvent = (calendar: string, extra: Record<string, unknown> = {}) => ({
  calendar,
  end: iso(base + 19 * HOUR),
  start: iso(base + 18 * HOUR),
  title: 'Dinner',
  ...extra,
});

describe('writes', () => {
  it.effect('a permitted create lands locally, queues the push and is logged', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = writer();
      const result = (yield* callTool(agent, 'create_event', newEvent(refs.calendar('work')))) as {
        event: EventDto;
        status: string;
      };
      expect(result.status).toBe('done');
      expect(result.event).toMatchObject({ pendingSync: true, title: 'Dinner' });

      const ops = yield* (yield* PendingOpRepo).listAll();
      expect(ops.map((op) => [op.kind, op.calendarId])).toEqual([['create', 'work']]);
      expect(titles(yield* callTool(agent, 'list_events', range))).toContain('Dinner');

      expect(yield* activity).toMatchObject([
        {
          agentId: agent.id,
          agentName: 'Test agent',
          status: 'done',
          summary: { title: 'Create event “Dinner”' },
          tool: 'create_event',
        },
      ]);
    }).pipe(Effect.provide(world.layer));
  });

  it.effect('the grant decides: read is denied and logged, none does not exist', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = writer();
      const denied = yield* failureOf(
        callTool(agent, 'create_event', newEvent(refs.calendar('private'))),
      );
      expect(denied).toMatchObject({ _tag: 'PermissionDenied', reason: 'level' });

      // No grant and hidden-in-the-app answer exactly like a calendar that is not there.
      for (const calendar of ['hidden', 'does-not-exist']) {
        const missing = yield* failureOf(
          callTool(agent, 'create_event', newEvent(refs.calendar(calendar))),
        );
        expect(missing).toMatchObject({ _tag: 'NotFound', what: 'Calendar' });
      }

      const readOnly = yield* failureOf(
        callTool(agent, 'create_event', newEvent(refs.calendar('team'))),
      );
      expect(readOnly).toMatchObject({ _tag: 'PermissionDenied', reason: 'readOnly' });

      expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      // Refusals are logged; "not found" is not (there is nothing to name).
      expect((yield* activity).map((row) => row.status)).toEqual(['blocked', 'blocked']);
    }).pipe(Effect.provide(world.layer));
  });

  it.effect('guests need their own capability — on create, edit and delete', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const invite = newEvent(refs.calendar('work'), {
        attendees: [{ email: 'ben@example.com', name: 'Ben' }],
      });
      const noGuests = writer();
      for (const [tool, input] of [
        ['create_event', invite],
        // Lunch already has a guest: any change notifies her.
        ['update_event', { ref: refs.event('work', 'lunch'), title: 'Late lunch' }],
        ['delete_event', { ref: refs.event('work', 'lunch') }],
      ] as const) {
        expect(yield* failureOf(callTool(noGuests, tool, input))).toMatchObject({
          _tag: 'PermissionDenied',
          reason: 'guests',
        });
      }
      expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      expect((yield* (yield* EventRepo).getById(ACCOUNT, 'work', 'lunch'))?.title).toBe(
        'Lunch with Ana',
      );

      // An event without guests is unaffected by the capability.
      yield* callTool(noGuests, 'update_event', {
        ref: refs.event('work', 'standup'),
        title: 'Daily',
      });

      const withGuests = writer({ guests: 'allow' });
      const created = (yield* callTool(withGuests, 'create_event', invite)) as { event: EventDto };
      expect(created.event.attendees?.map((guest) => guest.email)).toContain('ben@example.com');
    }).pipe(Effect.provide(world.layer));
  });

  it.effect('edits one event and reports a no-op or a bad time as invalid input', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = writer();
      yield* callTool(agent, 'update_event', {
        location: 'Room 2',
        ref: refs.event('work', 'standup'),
        start: iso(base + 9 * HOUR),
      });
      const stored = yield* (yield* EventRepo).getById(ACCOUNT, 'work', 'standup');
      // A moved start keeps the hour-long duration.
      expect(stored).toMatchObject({
        endUtc: base + 10 * HOUR,
        location: 'Room 2',
        startUtc: base + 9 * HOUR,
        syncStatus: 'pending',
      });

      expect(
        (yield* failureOf(callTool(agent, 'update_event', { ref: refs.event('work', 'standup') })))
          ._tag,
      ).toBe('InvalidInput');
      expect(
        (yield* failureOf(
          callTool(agent, 'update_event', {
            end: iso(base + 8 * HOUR),
            ref: refs.event('work', 'standup'),
          }),
        ))._tag,
      ).toBe('InvalidInput');
      expect(
        (yield* failureOf(callTool(agent, 'update_event', { ref: 'evt_garbage', title: 'x' })))
          ._tag,
      ).toBe('InvalidInput');
    }).pipe(Effect.provide(world.layer));
  });

  it.effect('an occurrence edit is routed to the series with its scope', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = writer();
      const slot = seriesStart + 7 * DAY;
      yield* callTool(agent, 'update_event', {
        ref: refs.occurrence('work', 'weekly', slot),
        title: 'Weekly sync (moved room)',
      });
      const events = yield* EventRepo;
      const overrides = yield* events.listOverrides(ACCOUNT, 'work', 'weekly');
      expect(overrides).toMatchObject([
        { originalStartUtc: slot, title: 'Weekly sync (moved room)' },
      ]);
      // Only this occurrence: the master keeps its title.
      expect((yield* events.getById(ACCOUNT, 'work', 'weekly'))?.title).toBe('Weekly sync');

      yield* callTool(agent, 'delete_event', {
        ref: refs.occurrence('work', 'weekly', slot),
        scope: 'series',
      });
      expect(titles(yield* callTool(agent, 'list_events', range))).not.toContain(
        'Weekly sync (moved room)',
      );
      expect((yield* activity).map((row) => row.summary.lines)).toContainEqual(
        expect.arrayContaining(['Applies to: Every occurrence of the series']),
      );
    }).pipe(Effect.provide(world.layer));
  });

  it.effect(
    "Apple: a ref pairing a granted calendar with another calendar's event is refused",
    () => {
      const world = makeWorld();
      return Effect.gen(function* () {
        const agent = writer();
        // EventKit addresses events by id alone — the gateway must not.
        const forged = refs.event('ek-home', 'ek-plan', APPLE_CALENDAR_ACCOUNT_ID);
        for (const [tool, input] of [
          ['update_event', { ref: forged, title: 'Pwned' }],
          ['delete_event', { ref: forged }],
        ] as const) {
          expect(yield* failureOf(callTool(agent, tool, input))).toMatchObject({
            _tag: 'NotFound',
            what: 'Event',
          });
        }
        // Nor does its honest ref work without a grant on that calendar.
        expect(
          (yield* failureOf(
            callTool(agent, 'delete_event', {
              ref: refs.event('ek-secret', 'ek-plan', APPLE_CALENDAR_ACCOUNT_ID),
            }),
          ))._tag,
        ).toBe('NotFound');
        expect(world.apple.state.series.get('ek-plan')?.event.title).toBe('Secret plan');
        expect(world.apple.state.calls.filter((call) => /update|delete/u.test(call))).toEqual([]);

        // The granted calendar's own event is writable.
        yield* callTool(agent, 'update_event', {
          ref: refs.event('ek-home', 'ek-dentist', APPLE_CALENDAR_ACCOUNT_ID),
          title: 'Dentist (moved)',
        });
        expect(world.apple.state.series.get('ek-dentist')?.event.title).toBe('Dentist (moved)');
      }).pipe(Effect.provide(world.layer));
    },
  );

  it.effect('a field the provider cannot hold fails loudly, never silently', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = writer({ guests: 'allow' });
      // Apple calendars cannot hold guests.
      expect(
        yield* failureOf(
          callTool(
            agent,
            'create_event',
            newEvent(refs.appleHome, { attendees: [{ email: 'ben@example.com' }] }),
          ),
        ),
      ).toMatchObject({ _tag: 'Unsupported', provider: 'apple' });
      // Google Tasks cannot hold a due time.
      expect(
        yield* failureOf(
          callTool(agent, 'create_task', {
            dueDate: baseDate,
            dueTime: '09:00',
            list: refs.googleList,
            title: 'Timed',
          }),
        ),
      ).toMatchObject({ _tag: 'Unsupported', field: 'dueTime', provider: 'google' });
      expect((yield* activity).map((row) => [row.status, row.error?.code])).toEqual([
        ['failed', 'Unsupported'],
        ['failed', 'Unsupported'],
      ]);
      expect(world.apple.state.series.size).toBe(2);
    }).pipe(Effect.provide(world.layer));
  });

  it.effect('tasks: writes follow the list the task is really in', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = writer();
      // Reminders addresses a reminder by id alone: naming a granted list must not unlock it.
      const forged = refs.task('list-a', 'rem-b');
      expect(
        (yield* failureOf(callTool(agent, 'update_task', { completed: true, ref: forged })))._tag,
      ).toBe('NotFound');
      expect((yield* failureOf(callTool(agent, 'delete_task', { ref: forged })))._tag).toBe(
        'NotFound',
      );
      expect(
        (yield* failureOf(callTool(agent, 'delete_task', { ref: refs.task('list-b', 'rem-b') })))
          ._tag,
      ).toBe('NotFound');
      expect(world.reminders.state.reminders.get('rem-b')).toMatchObject({
        completed: false,
        title: 'Private errand',
      });

      yield* callTool(agent, 'update_task', {
        completed: true,
        ref: refs.task('list-a', 'rem-a'),
        title: 'Call mum',
      });
      expect(world.reminders.state.reminders.get('rem-a')).toMatchObject({
        completed: true,
        title: 'Call mum',
      });

      const created = (yield* callTool(agent, 'create_task', {
        dueDate: baseDate,
        list: refs.reminderList('list-a'),
        priority: 'high',
        title: 'Buy flowers',
      })) as { task: TaskDto };
      expect(created.task).toMatchObject({ priority: 'high', title: 'Buy flowers' });
      expect(
        yield* (yield* TaskRepo).get(APPLE_REMINDERS_ACCOUNT_ID, 'list-a', 'rem-a'),
      ).toMatchObject({ status: 'completed' });

      // A list Reminders keeps read-only is not writable under any grant.
      expect(
        yield* failureOf(
          callTool(agent, 'create_task', {
            dueDate: baseDate,
            list: refs.reminderList('list-ro'),
            title: 'Nope',
          }),
        ),
      ).toMatchObject({ _tag: 'PermissionDenied', reason: 'readOnly' });
    }).pipe(Effect.provide(world.layer));
  });
});

const asker = (overrides: Parameters<typeof agentWith>[0] = {}) => ({
  ...EMPTY_POLICY,
  calendars: [grantCalendar('work', 'ask')],
  ...overrides,
});

/** A stored agent — approvals look the agent up again when they execute. */
const storedAgent = (policy = asker()) =>
  Effect.map(createAgent('Hermes', policy), ({ agent }): AgentRecord => agent);

describe('ask first', () => {
  it.effect('the call waits; approving executes the write exactly once', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = yield* storedAgent();
      const asked = yield* watchApprovals;
      const call = yield* Effect.forkChild(
        callTool(agent, 'create_event', newEvent(refs.calendar('work'))),
      );
      const request = yield* untilAsked(asked);
      expect(request).toMatchObject({
        agentName: 'Hermes',
        status: 'pending',
        summary: { title: 'Create event “Dinner”' },
      });
      expect(request.summary.lines[0]).toBe('Calendar: Work (me@example.com)');
      // Nothing is written while the user has not answered.
      expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);

      const settled = yield* decideRequest(request.id, 'approve');
      expect(settled).toMatchObject({ status: 'done' });
      expect(yield* Fiber.join(call)).toMatchObject({ event: { title: 'Dinner' }, status: 'done' });

      // A second click, or the other window, changes nothing.
      expect(yield* decideRequest(request.id, 'approve')).toMatchObject({ status: 'done' });
      expect(yield* decideRequest(request.id, 'deny')).toMatchObject({ status: 'done' });
      expect((yield* (yield* PendingOpRepo).listAll()).map((op) => op.kind)).toEqual(['create']);
      expect((yield* activity).map((row) => row.status)).toEqual(['done']);
    }).pipe(Effect.provide(world.layer));
  });

  it.effect('denying fails the call and writes nothing', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = yield* storedAgent();
      const asked = yield* watchApprovals;
      const call = yield* Effect.forkChild(
        failureOf(callTool(agent, 'delete_event', { ref: refs.event('work', 'standup') })),
      );
      const request = yield* untilAsked(asked);
      expect(yield* decideRequest(request.id, 'deny')).toMatchObject({ status: 'denied' });
      expect(yield* Fiber.join(call)).toMatchObject({
        _tag: 'PermissionDenied',
        reason: 'userDenied',
      });
      expect((yield* (yield* EventRepo).getById(ACCOUNT, 'work', 'standup'))?.status).toBe(
        'confirmed',
      );
      expect(yield* decideRequest(request.id, 'approve')).toMatchObject({ status: 'denied' });
      expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
    }).pipe(Effect.provide(world.layer));
  });

  it.effect('after the wait the agent gets a request id to poll — and only its own', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = yield* storedAgent();
      const asked = yield* watchApprovals;
      const call = yield* Effect.forkChild(
        callTool(agent, 'create_event', newEvent(refs.calendar('work'))),
      );
      const request = yield* untilAsked(asked);
      yield* TestClock.adjust('26 seconds');
      expect(yield* Fiber.join(call)).toMatchObject({
        requestId: request.id,
        status: 'pending_approval',
      });

      expect(yield* callTool(agent, 'get_request', { requestId: request.id })).toMatchObject({
        status: 'pending_approval',
      });
      // Another agent cannot see it, let alone tell it exists.
      expect(
        (yield* failureOf(callTool(agentWith({}), 'get_request', { requestId: request.id })))._tag,
      ).toBe('NotFound');

      yield* decideRequest(request.id, 'approve');
      expect(yield* callTool(agent, 'get_request', { requestId: request.id })).toMatchObject({
        result: { event: { title: 'Dinner' }, status: 'done' },
        status: 'done',
      });
    }).pipe(Effect.provide(world.layer));
  });

  it.effect('the same write sent again joins the waiting request; pending is capped', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = yield* storedAgent();
      const asked = yield* watchApprovals;
      const input = newEvent(refs.calendar('work'));
      // Key order must not make the retry look like a new request.
      const reordered = Object.fromEntries(Object.entries(input).reverse());
      const first = yield* Effect.forkChild(callTool(agent, 'create_event', input));
      yield* untilAsked(asked);
      const second = yield* Effect.forkChild(callTool(agent, 'create_event', reordered));
      yield* TestClock.adjust('26 seconds');
      const [a, b] = [yield* Fiber.join(first), yield* Fiber.join(second)];
      expect(a).toEqual(b);
      expect(asked).toHaveLength(1);

      for (let index = 1; index < MAX_PENDING_PER_AGENT; index += 1) {
        yield* Effect.forkChild(
          callTool(agent, 'create_event', { ...input, title: `Dinner ${index}` }),
        );
      }
      yield* untilAsked(asked, MAX_PENDING_PER_AGENT);
      expect(
        (yield* failureOf(callTool(agent, 'create_event', { ...input, title: 'One too many' })))
          ._tag,
      ).toBe('RateLimited');
    }).pipe(Effect.provide(world.layer));
  });

  it.effect(
    'approval re-checks the grant: a narrowed grant or a removed agent stops the write',
    () => {
      const world = makeWorld();
      return Effect.gen(function* () {
        const agent = yield* storedAgent();
        const asked = yield* watchApprovals;
        yield* Effect.forkChild(callTool(agent, 'create_event', newEvent(refs.calendar('work'))));
        const narrowed = yield* untilAsked(asked);
        yield* updateAgent(agent.id, {
          policy: asker({ calendars: [grantCalendar('work', 'read')] }),
        });
        expect(yield* decideRequest(narrowed.id, 'approve')).toMatchObject({
          error: { code: 'PermissionDenied' },
          status: 'failed',
        });

        yield* updateAgent(agent.id, { policy: asker() });
        yield* Effect.forkChild(
          callTool(agent, 'create_event', newEvent(refs.calendar('work'), { title: 'Other' })),
        );
        const orphaned = yield* untilAsked(asked, 2);
        yield* removeAgent(agent.id);
        expect(yield* decideRequest(orphaned.id, 'approve')).toMatchObject({ status: 'expired' });

        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      }).pipe(Effect.provide(world.layer));
    },
  );

  it.effect('guests set to "ask" sends an otherwise allowed write to the user', () => {
    const world = makeWorld();
    return Effect.gen(function* () {
      const agent = yield* storedAgent(
        asker({ calendars: [grantCalendar('work', 'write')], guests: 'ask' }),
      );
      const asked = yield* watchApprovals;
      // No guests: straight through.
      yield* callTool(agent, 'create_event', newEvent(refs.calendar('work')));
      expect(asked).toHaveLength(0);

      yield* Effect.forkChild(
        callTool(
          agent,
          'create_event',
          newEvent(refs.calendar('work'), { attendees: [{ email: 'ben@example.com' }] }),
        ),
      );
      const request = yield* untilAsked(asked);
      expect(request.summary.lines).toContain(
        'Guests: ben@example.com — they will be emailed an invitation',
      );
    }).pipe(Effect.provide(world.layer));
  });
});
