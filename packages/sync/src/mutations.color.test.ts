import { CalendarInfo } from '@calendar/core';
import { CalendarRepo, PendingOpRepo, reposLayer, runMigrations } from '@calendar/db';
import {
  GoogleCalendarClient,
  type GoogleCalendarClientShape,
  GoogleTasksClient,
  type GoogleTasksClientShape,
} from '@calendar/google';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { CALENDAR_COLOR_EVENT_ID, EventMutations } from './mutations.ts';

const stubTasksClient: GoogleTasksClientShape = {
  deleteTask: () => Effect.die('tasks not used in this test'),
  insertTask: () => Effect.die('tasks not used in this test'),
  listTaskLists: () => Effect.die('tasks not used in this test'),
  listTasks: () => Effect.die('tasks not used in this test'),
  patchTask: () => Effect.die('tasks not used in this test'),
};

const makeLayer = (overrides: Partial<GoogleCalendarClientShape>) =>
  EventMutations.layer.pipe(
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(
      Layer.succeed(GoogleCalendarClient, {
        deleteEvent: () => Effect.void,
        getColors: () => Effect.succeed({ calendar: {} }),
        insertEvent: () => Effect.die('unexpected insert'),
        listCalendars: () => Effect.succeed({ items: [] }),
        listEvents: () => Effect.succeed({ items: [] }),
        patchCalendarListEntry: () => Effect.die('unexpected calendarList patch'),
        patchEvent: () => Effect.die('unexpected patch'),
        ...overrides,
      }),
    ),
    Layer.provideMerge(Layer.succeed(GoogleTasksClient, stubTasksClient)),
  );

const workCalendar = (accountId: string) =>
  new CalendarInfo({
    accessRole: 'owner',
    accountId,
    colorHex: '#3b82f6',
    id: 'cal-1',
    isPrimary: true,
    isVisible: false,
    summary: 'Work',
    timeZone: 'UTC',
  });

const seed = Effect.gen(function* () {
  const calendars = yield* CalendarRepo;
  yield* calendars.upsertMany([workCalendar('acc-1'), workCalendar('acc-2')]);
});

const colorOf = (accountId: string) =>
  Effect.gen(function* () {
    const calendars = yield* (yield* CalendarRepo).list(accountId);
    return calendars[0]!.colorHex;
  });

describe('EventMutations.setCalendarColor', () => {
  it.effect('updates locally, patches Google, and self-heals from the response', () => {
    const patches: Array<{ backgroundColor: string; calendarId: string; foregroundColor: string }> =
      [];
    const layer = makeLayer({
      patchCalendarListEntry: ({ backgroundColor, calendarId, foregroundColor }) => {
        patches.push({ backgroundColor, calendarId, foregroundColor });
        return Effect.succeed({
          accessRole: 'owner',
          backgroundColor,
          id: calendarId,
          summary: 'Work',
        });
      },
    });
    return Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      yield* mutations.setCalendarColor({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        colorHex: '#16A765',
      });
      // Optimistic + normalized to lowercase.
      expect(yield* colorOf('acc-1')).toBe('#16a765');
      expect(yield* colorOf('acc-2')).toBe('#3b82f6');

      // Simulate a pull overwriting the color while the op is queued.
      const calendars = yield* CalendarRepo;
      yield* calendars.upsertMany([workCalendar('acc-1')]);
      expect(yield* colorOf('acc-1')).toBe('#3b82f6');

      yield* mutations.processPendingOps();
      expect(patches).toEqual([
        { backgroundColor: '#16a765', calendarId: 'cal-1', foregroundColor: '#ffffff' },
      ]);
      // The response upsert restored the chosen color...
      expect(yield* colorOf('acc-1')).toBe('#16a765');
      // ...without resurrecting visibility (upsert must not touch it).
      const [calendar] = yield* calendars.list('acc-1');
      expect(calendar!.isVisible).toBe(false);

      const ops = yield* (yield* PendingOpRepo).listAll();
      expect(ops).toHaveLength(0);
    }).pipe(Effect.provide(layer));
  });

  it.effect('coalesces per account: only the latest color op survives', () =>
    Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      yield* mutations.setCalendarColor({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        colorHex: '#f83a22',
      });
      yield* mutations.setCalendarColor({
        accountId: 'acc-2',
        calendarId: 'cal-1',
        colorHex: '#7bd148',
      });
      yield* mutations.setCalendarColor({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        colorHex: '#4986e7',
      });

      const ops = yield* (yield* PendingOpRepo).listAll();
      expect(ops).toHaveLength(2);
      expect(ops.every((op) => op.eventId === CALENDAR_COLOR_EVENT_ID)).toBe(true);
      const byAccount = new Map(ops.map((op) => [op.accountId, op.colorHex]));
      expect(byAccount.get('acc-1')).toBe('#4986e7');
      // The other account's queued color is untouched by acc-1's coalescing.
      expect(byAccount.get('acc-2')).toBe('#7bd148');
    }).pipe(Effect.provide(makeLayer({}))),
  );

  it.effect('rejects invalid hex instead of queueing a doomed op', () =>
    Effect.gen(function* () {
      yield* seed;
      const mutations = yield* EventMutations;
      const exit = yield* Effect.exit(
        mutations.setCalendarColor({
          accountId: 'acc-1',
          calendarId: 'cal-1',
          colorHex: 'tomato',
        }),
      );
      expect(exit._tag).toBe('Failure');
      const ops = yield* (yield* PendingOpRepo).listAll();
      expect(ops).toHaveLength(0);
      expect(yield* colorOf('acc-1')).toBe('#3b82f6');
    }).pipe(Effect.provide(makeLayer({}))),
  );
});
