import { Attendee, CarriedText, EventRecord, GeoLocation, PendingOp } from '@calendar/core';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { SqlClient } from 'effect/sql/SqlClient';
import { describe } from 'vite-plus/test';
import { runMigrations } from './migrate.ts';
import { PendingOpRepo, reposLayer } from './repos.ts';

const freshDbLayer = () =>
  reposLayer.pipe(
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
  );

const op = (id: string, overrides: Partial<PendingOp> = {}) =>
  new PendingOp({
    accountId: 'acc-1',
    attempts: 0,
    calendarId: 'cal-1',
    createdAt: 1,
    eventId: `evt-${id}`,
    id,
    kind: 'update',
    nextAttemptAt: 0,
    ...overrides,
  });

/** A synced event row titled `title`, the shape a snapshot holds. */
const eventRow = (title: string) =>
  new EventRecord({
    accountId: 'acc-1',
    calendarId: 'cal-1',
    endUtc: 2,
    etag: '"e"',
    id: 'evt-1',
    isAllDay: false,
    startUtc: 1,
    status: 'confirmed',
    syncedAt: 1,
    syncStatus: 'synced',
    title,
    updatedAt: 1,
  });

/** An exception of series `m1`, as Google has it. */
const exception = (id: string, title: string) =>
  new EventRecord({ ...eventRow(title), id, originalStartUtc: 1, recurringEventId: 'm1' });

/** What the op reads as the exceptions its series delete took: `id title`, sorted. */
const taken = (opId: string) =>
  Effect.gen(function* () {
    const stored = yield* (yield* PendingOpRepo).getById(opId);
    return stored?.beforeOverrides?.map((row) => `${row.id} ${row.title}`).toSorted();
  });

const guest = (email: string, responseStatus: Attendee['responseStatus']) =>
  new Attendee({ email, responseStatus });

/** The user's version of the event an op holds, as the repo reads it now. */
const shown = (opId: string) =>
  Effect.gen(function* () {
    return (yield* (yield* PendingOpRepo).getById(opId))?.payload;
  });

describe('PendingOpRepo', () => {
  it.effect('what stood back for an op of its event or series is due once that op left', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      const waiting = (id: string, eventId: string, reason: string) =>
        Effect.andThen(repo.enqueue(op(id, { eventId })), repo.markFailed(id, 1, 60_000, reason));
      yield* waiting(
        'occurrence',
        'evt-1_20260701T100000Z',
        'waiting for the change of its series',
      );
      yield* waiting('series', 'evt-1', 'waiting for the change ahead of it');
      yield* waiting('other', 'evt-2', 'waiting for the change ahead of it');
      // In backoff for a failure of its own: not what this is about.
      yield* waiting('failed', 'evt-1_20260702T100000Z', 'Backend Error');
      expect(yield* repo.wakeWaiting({ accountId: 'acc-1', eventId: 'evt-1' })).toBe(2);
      expect((yield* repo.listDue(0)).map((one) => one.id)).toEqual(['occurrence', 'series']);
      // An occurrence's op that left wakes what waited for it in its series.
      yield* repo.markFailed('series', 2, 60_000, 'waiting for the change ahead of it');
      expect(
        yield* repo.wakeWaiting({ accountId: 'acc-1', eventId: 'evt-1_20260701T100000Z' }),
      ).toBe(1);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('an op queued in place of another stands where that one stood', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(op('first', { createdAt: 1, eventId: 'evt-1' }));
      yield* repo.enqueue(op('behind', { createdAt: 1, eventId: 'evt-1_20260701T100000Z' }));
      yield* repo.enqueue(op('later', { createdAt: 5, eventId: 'evt-2' }));
      // Queued now, it would sort last; it takes the first one's place.
      yield* repo.enqueue(op('second', { createdAt: 9, eventId: 'evt-1' }), 'first');
      expect((yield* repo.listAll()).map((one) => `${one.id} ${one.createdAt}`)).toEqual([
        'second 1',
        'behind 1',
        'later 5',
      ]);
      // Naming an op that left meanwhile: queued at the end, as ever.
      yield* repo.enqueue(op('third', { createdAt: 9, eventId: 'evt-1' }), 'first');
      expect((yield* repo.listAll()).map((one) => one.id)).toEqual([
        'second',
        'behind',
        'later',
        'third',
      ]);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('counts the ops waiting for a set of calendars and task lists', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(op('a'));
      yield* repo.enqueue(op('b', { calendarId: 'cal-2' }));
      yield* repo.enqueue(op('c', { kind: 'updateTask', taskListId: 'list-1' }));
      yield* repo.enqueue(op('d', { accountId: 'acc-2' }));
      const count = (calendarIds: Array<string>, taskListIds: Array<string>) =>
        repo.countFor('acc-1', { calendarIds, taskListIds });
      expect(yield* count(['cal-2'], [])).toBe(1);
      expect(yield* count([], ['list-1'])).toBe(1);
      expect(yield* count(['cal-1', 'cal-2'], ['list-1'])).toBe(3);
      expect(yield* count(['cal-9'], ['list-9'])).toBe(0);
      expect(yield* count([], [])).toBe(0);
      // A task move counts for the list it goes into too.
      yield* repo.enqueue(
        op('e', { kind: 'moveTask', targetTaskListId: 'list-2', taskListId: 'list-1' }),
      );
      expect(yield* count([], ['list-2'])).toBe(1);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('round-trips every optional field, payload included', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      const payload = new EventRecord({
        accountId: 'acc-1',
        attendees: [new Attendee({ email: 'guest@example.com', responseStatus: 'needsAction' })],
        calendarId: 'cal-1',
        endUtc: 2,
        etag: '"e"',
        id: 'evt-1',
        isAllDay: false,
        location: 'Room 1',
        startUtc: 1,
        status: 'confirmed',
        syncedAt: 1,
        syncStatus: 'pending',
        title: 'Standup',
        updatedAt: 1,
      });
      const carriedText = new CarriedText({
        base: { description: null, location: 'Room 1', title: 'Daily' },
        overrides: [
          {
            etag: '"o-1"',
            eventId: 'evt-1_x',
            geo: new GeoLocation({ lat: 48.2, lng: 16.37, source: 'Stephansplatz 3, Wien' }),
            location: 'Stephansplatz 3, Wien',
            title: 'Daily (moved)',
          },
        ],
      });
      yield* repo.enqueue(
        op('op-1', {
          baseEtag: '"server"',
          beforeColorHex: '#00ff00',
          beforePayload: new EventRecord({ ...payload, title: 'Before' }),
          carriedText,
          colorHex: '#ff0000',
          lastError: 'boom',
          payload,
          remindersChanged: true,
        }),
      );

      const [stored] = yield* repo.listAll();
      expect(stored?.baseEtag).toBe('"server"');
      expect(stored?.remindersChanged).toBe(true);
      expect(stored?.colorHex).toBe('#ff0000');
      expect(stored?.lastError).toBe('boom');
      expect(stored?.payload?.title).toBe('Standup');
      expect(stored?.payload?.location).toBe('Room 1');
      expect(stored?.payload?.attendees?.[0]?.email).toBe('guest@example.com');
      expect(stored?.carriedText).toEqual(carriedText);
      expect(stored?.beforePayload?.title).toBe('Before');
      expect(stored?.beforeColorHex).toBe('#00ff00');
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect(
    'an event op reads Google’s copy of its event: one per event, null when Google has none',
    () =>
      Effect.gen(function* () {
        const repo = yield* PendingOpRepo;
        // The first op to hold the event keeps Google's copy; one queued
        // after it reads that copy, whatever it was handed.
        yield* repo.enqueue(op('edit', { beforePayload: eventRow('A'), eventId: 'evt-1' }));
        yield* repo.enqueue(
          op('answer', { beforePayload: eventRow('A, edited'), eventId: 'evt-1', kind: 'rsvp' }),
        );
        // An occurrence whose override the change materialized: Google has none.
        yield* repo.enqueue(op('none', { beforePayload: null }));
        yield* repo.enqueue(op('made', { kind: 'create' }));
        const stored = Object.fromEntries(
          (yield* repo.listAll()).map((entry) => [entry.id, entry.beforePayload]),
        );
        expect(stored['edit']?.title).toBe('A');
        expect(stored['answer']?.title).toBe('A');
        expect(stored['none']).toBeNull();
        // A create replaces nothing.
        expect(stored['made']).toBeUndefined();
        // The copy goes with the last op that names the event.
        yield* repo.remove('edit');
        expect((yield* repo.getById('answer'))?.beforePayload?.title).toBe('A');
        yield* repo.remove('answer');
        yield* repo.enqueue(op('later', { beforePayload: eventRow('B'), eventId: 'evt-1' }));
        expect((yield* repo.getById('later'))?.beforePayload?.title).toBe('B');
      }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('keeps a due day taken away apart from one left alone', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      const task = { kind: 'updateTask' as const, taskListId: 'list-1' };
      yield* repo.enqueue(op('cleared', { ...task, taskDue: null }));
      yield* repo.enqueue(op('dated', { ...task, taskDue: '2026-08-30' }));
      yield* repo.enqueue(op('untouched', { ...task, taskTitle: 'Renamed' }));
      const stored = Object.fromEntries(
        (yield* repo.listAll()).map((entry) => [entry.id, entry.taskDue]),
      );
      expect(stored['cleared']).toBeNull();
      expect(stored['dated']).toBe('2026-08-30');
      expect(stored['untouched']).toBeUndefined();
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('advanceBefore moves Google’s copy of the event to what landed', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      const event = { accountId: 'acc-1', calendarId: 'cal-1', eventId: 'evt-1' };
      yield* repo.enqueue(
        op('landed', { beforePayload: eventRow('A'), createdAt: 1, eventId: 'evt-1' }),
      );
      yield* repo.enqueue(
        op('after', { beforePayload: eventRow('A'), createdAt: 2, eventId: 'evt-1' }),
      );
      yield* repo.enqueue(
        op('other', { beforePayload: eventRow('A'), createdAt: 5, eventId: 'evt-2' }),
      );
      yield* repo.advanceBefore(event, eventRow('B'), { id: 'landed' });
      const titles = Object.fromEntries(
        (yield* repo.listAll()).map((entry) => [entry.id, entry.beforePayload?.title]),
      );
      // One copy per event: every op of it replaces what landed now.
      expect(titles).toEqual({ after: 'B', landed: 'B', other: 'A' });
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('setBefore replaces Google’s copy of the op’s event, and null forgets it', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(op('event', { beforePayload: eventRow('A'), eventId: 'evt-1' }));
      yield* repo.enqueue(op('same', { beforePayload: eventRow('A'), eventId: 'evt-1' }));
      yield* repo.enqueue(op('other', { beforePayload: eventRow('A'), eventId: 'evt-2' }));
      yield* repo.setBefore('event', eventRow('C'));
      const titles = () =>
        Effect.map(repo.listAll(), (ops) =>
          Object.fromEntries(ops.map((entry) => [entry.id, entry.beforePayload?.title ?? null])),
        );
      expect(yield* titles()).toEqual({ event: 'C', other: 'A', same: 'C' });
      yield* repo.setBefore('event', null);
      expect(yield* titles()).toEqual({ event: null, other: 'A', same: null });
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('listForTask finds a task’s ops in every list of the account, in queue order', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      const taskOp = (id: string, kind: PendingOp['kind'], overrides: Partial<PendingOp> = {}) =>
        op(id, { calendarId: 'list-1', eventId: 't-1', kind, taskListId: 'list-1', ...overrides });
      yield* repo.enqueue(taskOp('move', 'moveTask', { targetTaskListId: 'list-2' }));
      yield* repo.enqueue(taskOp('edit', 'updateTask', { calendarId: 'list-2' }));
      yield* repo.enqueue(taskOp('other', 'updateTask', { eventId: 't-2' }));
      yield* repo.enqueue(taskOp('elsewhere', 'updateTask', { accountId: 'acc-2' }));
      // An event that happens to share the id is not a task op.
      yield* repo.enqueue(op('event', { eventId: 't-1' }));
      expect((yield* repo.listForTask('acc-1', 't-1')).map((entry) => entry.id)).toEqual([
        'move',
        'edit',
      ]);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('forgetDeleted forgets Google’s copies of the deleted events', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      const before = eventRow('A');
      yield* repo.enqueue(op('del', { beforePayload: before, eventId: 'evt-1', kind: 'delete' }));
      yield* repo.enqueue(op('upd', { beforePayload: before, eventId: 'evt-1', kind: 'update' }));
      yield* repo.enqueue(op('other', { beforePayload: before, eventId: 'evt-2', kind: 'delete' }));
      yield* repo.forgetDeleted('acc-1', 'cal-1', ['evt-1']);
      const kept = Object.fromEntries(
        (yield* repo.listAll()).map((entry) => [entry.id, entry.beforePayload !== null]),
      );
      expect(kept).toEqual({ del: false, other: true, upd: false });
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('forgetSeries leaves the queued ops of a deleted series’ occurrences nothing', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      const before = eventRow('A');
      const queue = (id: string, eventId: string, calendarId = 'cal-1') =>
        repo.enqueue(op(id, { beforePayload: before, calendarId, eventId, kind: 'update' }));
      yield* queue('occurrence', 'm1_20260704T090000Z');
      yield* queue('allDay', 'm1_20260704');
      yield* queue('master', 'm1');
      yield* queue('split', 'm1_R20260704T090000Z');
      yield* queue('other', 'm10_20260704T090000Z');
      yield* queue('elsewhere', 'm1_20260704T090000Z', 'cal-2');
      yield* repo.forgetSeries('acc-1', 'cal-1', 'm1');
      const stored = Object.fromEntries(
        (yield* repo.listAll()).map((entry) => [entry.id, entry.beforePayload?.title ?? null]),
      );
      expect(stored).toEqual({
        allDay: null,
        elsewhere: 'A',
        master: 'A',
        occurrence: null,
        other: 'A',
        split: 'A',
      });
    }).pipe(Effect.provide(freshDbLayer())),
  );

  describe('an update or an answer keeps only what it changed', () => {
    const event = { accountId: 'acc-1', calendarId: 'cal-1', eventId: 'evt-1' };

    it.effect('its version is Google’s copy, as it is now, with those fields over it', () =>
      Effect.gen(function* () {
        const repo = yield* PendingOpRepo;
        const copy = new EventRecord({ ...eventRow('Standup'), location: 'Room 1' });
        yield* repo.enqueue(
          op('rename', {
            beforePayload: copy,
            eventId: 'evt-1',
            payload: new EventRecord({ ...copy, syncStatus: 'pending', title: 'Standup (mine)' }),
          }),
        );
        // Another device moved it to another room and wrote notes.
        yield* repo.advanceBefore(
          event,
          new EventRecord({ ...copy, description: 'Agenda', etag: '"e2"', location: 'Room 2' }),
          { id: 'none' },
        );
        const mine = yield* shown('rename');
        expect([mine?.title, mine?.location, mine?.description, mine?.etag]).toEqual([
          'Standup (mine)',
          'Room 2',
          'Agenda',
          '"e2"',
        ]);
        expect(mine?.syncStatus).toBe('pending');
      }).pipe(Effect.provide(freshDbLayer())),
    );

    it.effect(
      'once Google has only a tombstone of the event, its version is the one it was queued with',
      () =>
        Effect.gen(function* () {
          const repo = yield* PendingOpRepo;
          const copy = new EventRecord({ ...eventRow('Standup'), location: 'Room 1' });
          yield* repo.enqueue(
            op('rename', {
              beforePayload: copy,
              eventId: 'evt-1',
              payload: new EventRecord({ ...copy, syncStatus: 'pending', title: 'Standup (mine)' }),
            }),
          );
          yield* repo.advanceBefore(
            event,
            new EventRecord({ ...eventRow('(deleted)'), status: 'cancelled' }),
            { id: 'none' },
          );
          const mine = yield* shown('rename');
          expect([mine?.title, mine?.location, mine?.status]).toEqual([
            'Standup (mine)',
            'Room 1',
            'confirmed',
          ]);
        }).pipe(Effect.provide(freshDbLayer())),
    );

    it.effect('a time is kept whole, and an emptied field stays empty', () =>
      Effect.gen(function* () {
        const repo = yield* PendingOpRepo;
        const copy = new EventRecord({
          ...eventRow('Standup'),
          endUtc: 60,
          location: 'Room 1',
          startUtc: 0,
        });
        const { location: _emptied, ...rest } = copy;
        yield* repo.enqueue(
          op('shorten', {
            beforePayload: copy,
            eventId: 'evt-1',
            payload: new EventRecord({ ...rest, endUtc: 30, syncStatus: 'pending' }),
          }),
        );
        yield* repo.advanceBefore(
          event,
          new EventRecord({ ...copy, endUtc: 160, location: 'Room 2', startUtc: 100 }),
          { id: 'none' },
        );
        const mine = yield* shown('shorten');
        expect([mine?.startUtc, mine?.endUtc, mine?.location]).toEqual([0, 30, undefined]);
      }).pipe(Effect.provide(freshDbLayer())),
    );

    it.effect('an answer is laid over whoever Google has on the guest list now', () =>
      Effect.gen(function* () {
        const repo = yield* PendingOpRepo;
        const copy = new EventRecord({
          ...eventRow('Planning'),
          attendees: [guest('me@example.com', 'needsAction'), guest('bob@example.com', 'accepted')],
        });
        yield* repo.enqueue(
          op('answer', {
            beforePayload: copy,
            eventId: 'evt-1',
            kind: 'rsvp',
            payload: new EventRecord({
              ...copy,
              attendees: [
                guest('me@example.com', 'accepted'),
                guest('bob@example.com', 'accepted'),
              ],
              syncStatus: 'pending',
            }),
          }),
        );
        yield* repo.advanceBefore(
          event,
          new EventRecord({
            ...copy,
            attendees: [
              guest('me@example.com', 'needsAction'),
              guest('bob@example.com', 'declined'),
              guest('dave@example.com', 'needsAction'),
            ],
          }),
          { id: 'none' },
        );
        expect(
          (yield* shown('answer'))?.attendees?.map((one) => `${one.email} ${one.responseStatus}`),
        ).toEqual([
          'me@example.com accepted',
          'bob@example.com declined',
          'dave@example.com needsAction',
        ]);
      }).pipe(Effect.provide(freshDbLayer())),
    );

    it.effect(
      'an edited guest list goes whole; an event Google has no copy of keeps its version',
      () =>
        Effect.gen(function* () {
          const repo = yield* PendingOpRepo;
          const copy = new EventRecord({
            ...eventRow('Planning'),
            attendees: [guest('bob@example.com', 'accepted')],
          });
          const mine = [
            guest('bob@example.com', 'accepted'),
            guest('carol@example.com', 'needsAction'),
          ];
          yield* repo.enqueue(
            op('guests', {
              attendeesChanged: true,
              beforePayload: copy,
              eventId: 'evt-1',
              payload: new EventRecord({ ...copy, attendees: mine, syncStatus: 'pending' }),
            }),
          );
          yield* repo.advanceBefore(
            event,
            new EventRecord({ ...copy, attendees: [guest('dave@example.com', 'needsAction')] }),
            { id: 'none' },
          );
          expect((yield* shown('guests'))?.attendees?.map((one) => one.email)).toEqual([
            'bob@example.com',
            'carol@example.com',
          ]);
          // An occurrence Google has no exception for: nothing to lay it over.
          yield* repo.enqueue(
            op('made', {
              beforePayload: null,
              eventId: 'evt-2',
              payload: new EventRecord({
                ...eventRow('Occurrence'),
                id: 'evt-2',
                syncStatus: 'pending',
              }),
            }),
          );
          expect((yield* shown('made'))?.title).toBe('Occurrence');
        }).pipe(Effect.provide(freshDbLayer())),
    );

    it.effect('each keeps its own: a version is the copy with the changes up to it, in order', () =>
      Effect.gen(function* () {
        const repo = yield* PendingOpRepo;
        const copy = new EventRecord({
          ...eventRow('Planning'),
          attendees: [guest('me@example.com', 'needsAction')],
        });
        const renamed = new EventRecord({ ...copy, syncStatus: 'pending', title: 'Planning (B)' });
        const answered = new EventRecord({
          ...renamed,
          attendees: [guest('me@example.com', 'accepted')],
        });
        yield* repo.enqueue(
          op('rename', { beforePayload: copy, createdAt: 1, eventId: 'evt-1', payload: renamed }),
        );
        // Made on a row that showed the rename: the title is not the answer's.
        yield* repo.enqueue(
          op('answer', {
            beforePayload: copy,
            changed: ['me@example.com'],
            createdAt: 2,
            eventId: 'evt-1',
            kind: 'rsvp',
            payload: answered,
          }),
        );
        yield* repo.enqueue(
          op('place', {
            beforePayload: copy,
            createdAt: 3,
            eventId: 'evt-1',
            payload: new EventRecord({ ...answered, location: 'Room 4' }),
          }),
        );
        const versions = Effect.map(repo.listForEvent(event), (ops) =>
          ops.map(
            (one) =>
              `${one.id}: ${one.payload?.title} @ ${one.payload?.location ?? '-'} ` +
              `${one.payload?.attendees?.[0]?.responseStatus} (${one.changed?.join(',')})`,
          ),
        );
        expect(yield* versions).toEqual([
          'rename: Planning (B) @ - needsAction (title)',
          'answer: Planning (B) @ - accepted (me@example.com)',
          'place: Planning (B) @ Room 4 accepted (location,geo)',
        ]);
        // What a change is laid over is the copy with the ones ahead of it.
        const place = (yield* repo.getById('place'))!;
        expect([place.basePayload?.title, place.basePayload?.location]).toEqual([
          'Planning (B)',
          undefined,
        ]);
        // The rename leaves the queue (replaced, or landed under another
        // title): it takes its title along, out of the others' versions.
        expect(
          (yield* repo.listForEvent(event, 'rename')).map((one) => one.payload?.title),
        ).toEqual(['Planning', 'Planning']);
        yield* repo.remove('rename');
        yield* repo.advanceBefore(event, new EventRecord({ ...copy, title: 'Planning (D)' }), {
          id: 'none',
        });
        expect(yield* versions).toEqual([
          'answer: Planning (D) @ - accepted (me@example.com)',
          'place: Planning (D) @ Room 4 accepted (location,geo)',
        ]);
      }).pipe(Effect.provide(freshDbLayer())),
    );

    it.effect('a field taken over from the update it replaces stays its own at any value', () =>
      Effect.gen(function* () {
        const repo = yield* PendingOpRepo;
        const copy = eventRow('Original');
        // A rename back to the title Google has, while the rename is out.
        yield* repo.enqueue(
          op('back', {
            beforePayload: copy,
            changed: ['title'],
            eventId: 'evt-1',
            payload: new EventRecord({ ...copy, syncStatus: 'pending' }),
          }),
        );
        expect((yield* repo.getById('back'))?.changed).toEqual(['title']);
        // The first rename landed: the copy moves on, the title stays.
        yield* repo.advanceBefore(event, new EventRecord({ ...copy, title: 'Renamed' }), {
          id: 'none',
        });
        expect((yield* shown('back'))?.title).toBe('Original');
        // And an answer keeps the answer it gave where Google has the same.
        const invited = new EventRecord({
          ...eventRow('Planning'),
          attendees: [guest('me@example.com', 'accepted')],
          id: 'evt-2',
        });
        yield* repo.enqueue(
          op('again', {
            beforePayload: invited,
            changed: ['me@example.com'],
            eventId: 'evt-2',
            kind: 'rsvp',
            payload: new EventRecord({ ...invited, syncStatus: 'pending' }),
          }),
        );
        yield* repo.advanceBefore(
          { ...event, eventId: 'evt-2' },
          new EventRecord({ ...invited, attendees: [guest('me@example.com', 'declined')] }),
          { id: 'none' },
        );
        expect((yield* shown('again'))?.attendees?.[0]?.responseStatus).toBe('accepted');
      }).pipe(Effect.provide(freshDbLayer())),
    );
  });

  it.effect('a move remembers that a pull found its event gone from the source', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(op('move', { eventId: 'e1', kind: 'move', targetCalendarId: 'cal-2' }));
      yield* repo.enqueue(op('edit', { eventId: 'e1' }));
      expect((yield* repo.getById('move'))?.sourceGone).toBeUndefined();
      yield* repo.markSourceGone(['move', 'edit']);
      expect((yield* repo.getById('move'))?.sourceGone).toBe(true);
      // Only a move has a source to be gone from.
      expect((yield* repo.getById('edit'))?.sourceGone).toBeUndefined();
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('keepGivenUp keeps a given-up change of the event or of its series, and no other', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      for (const queued of [
        op('own', { discarded: true, eventId: 'm1', kind: 'update' }),
        op('elsewhere', { calendarId: 'cal-2', discarded: true, eventId: 'm1', kind: 'update' }),
        op('other', { discarded: true, eventId: 'm10', kind: 'delete' }),
        // A sent move the user gave up asks Google where the event is.
        op('move', { discarded: true, eventId: 'm1', kind: 'move', targetCalendarId: 'cal-2' }),
      ]) {
        yield* repo.enqueue(queued);
      }
      const givenUp = Effect.map(repo.listAll(), (ops) =>
        ops.filter((queued) => queued.discarded === true).map((queued) => queued.id),
      );
      // A series split off in Google's own UI is no occurrence of its source.
      yield* repo.keepGivenUp({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        eventId: 'm1_R20260704T090000',
      });
      expect(yield* givenUp).toEqual(['own', 'elsewhere', 'other', 'move']);
      yield* repo.keepGivenUp({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        eventId: 'm1_20260704T090000Z',
      });
      expect(yield* givenUp).toEqual(['elsewhere', 'other', 'move']);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('listDeletes: the queued deletes of one calendar', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(op('series', { eventId: 'm1', kind: 'delete' }));
      yield* repo.enqueue(op('edit', { eventId: 'm2', kind: 'update' }));
      yield* repo.enqueue(op('elsewhere', { calendarId: 'cal-2', eventId: 'm1', kind: 'delete' }));
      yield* repo.enqueue(op('other', { accountId: 'acc-2', eventId: 'm1', kind: 'delete' }));
      const [remove, ...rest] = yield* repo.listDeletes('acc-1', 'cal-1');
      expect(remove?.id).toBe('series');
      expect(rest).toEqual([]);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  describe('the exceptions a series delete holds', () => {
    it.effect('are Google’s copies of them, read by the delete of their series', () =>
      Effect.gen(function* () {
        const repo = yield* PendingOpRepo;
        yield* repo.enqueue(
          op('series', {
            beforeOverrides: [exception('m1_1', 'Moved'), exception('m1_2', 'Renamed')],
            eventId: 'm1',
            kind: 'delete',
          }),
        );
        // Another series' delete, and an edit of this one, hold none of them.
        yield* repo.enqueue(op('other', { eventId: 'm2', kind: 'delete' }));
        yield* repo.enqueue(op('edit', { eventId: 'm1', kind: 'update' }));
        expect(yield* taken('series')).toEqual(['m1_1 Moved', 'm1_2 Renamed']);
        expect(yield* taken('other')).toBeUndefined();
        expect(yield* taken('edit')).toBeUndefined();

        yield* repo.setBeforeOverrides('series', [exception('m1_2', 'Renamed on Google')]);
        expect(yield* taken('series')).toEqual(['m1_2 Renamed on Google']);
        yield* repo.setBeforeOverrides('series', undefined);
        expect(yield* taken('series')).toBeUndefined();
      }).pipe(Effect.provide(freshDbLayer())),
    );

    it.effect('one is the copy an op of the exception reads too, and its own delete’s alone', () =>
      Effect.gen(function* () {
        const repo = yield* PendingOpRepo;
        yield* repo.enqueue(op('answer', { eventId: 'm1_1', kind: 'rsvp' }));
        yield* repo.enqueue(op('cut', { eventId: 'm1_2', kind: 'delete' }));
        yield* repo.enqueue(
          op('series', {
            beforeOverrides: [exception('m1_1', 'Moved'), exception('m1_2', 'Past the cut')],
            eventId: 'm1',
            kind: 'delete',
          }),
        );
        expect((yield* repo.getById('answer'))?.beforePayload?.title).toBe('Moved');
        expect((yield* repo.getById('cut'))?.beforePayload?.title).toBe('Past the cut');
        // The exception whose own delete waits is that delete's to put back.
        expect(yield* taken('series')).toEqual(['m1_1 Moved']);
        // Clearing what the series delete holds leaves what those ops hold.
        yield* repo.setBeforeOverrides('series', undefined);
        expect((yield* repo.getById('answer'))?.beforePayload?.title).toBe('Moved');
        expect(yield* taken('series')).toEqual(['m1_1 Moved']);
      }).pipe(Effect.provide(freshDbLayer())),
    );

    it.effect('go with the delete, and when a pull reports their series deleted', () =>
      Effect.gen(function* () {
        const repo = yield* PendingOpRepo;
        const sql = yield* SqlClient;
        const copies = Effect.map(
          sql<{ readonly id: string }>`SELECT id FROM event_copies ORDER BY id`,
          (rows) => rows.map((row) => row.id),
        );
        const held = [exception('m1_1', 'Moved')];
        yield* repo.enqueue(op('series', { beforeOverrides: held, eventId: 'm1', kind: 'delete' }));
        // Another op's removal leaves them: the series delete still waits.
        yield* repo.enqueue(op('edit', { eventId: 'evt-9' }));
        yield* repo.remove('edit');
        expect(yield* copies).toEqual(['m1_1']);
        yield* repo.remove('series');
        expect(yield* copies).toEqual([]);

        yield* repo.enqueue(op('again', { beforeOverrides: held, eventId: 'm1', kind: 'delete' }));
        yield* repo.forgetDeleted('acc-1', 'cal-1', ['m1']);
        expect(yield* copies).toEqual([]);
      }).pipe(Effect.provide(freshDbLayer())),
    );
  });

  it.effect(
    'a series update keeps where its drop starts; a snapshot can say nothing was there',
    () =>
      Effect.gen(function* () {
        const repo = yield* PendingOpRepo;
        yield* repo.enqueue(op('cut', { dropsFrom: 1234, eventId: 'm1', kind: 'update' }));
        yield* repo.enqueue(op('rename', { eventId: 'm2', kind: 'update' }));
        expect((yield* repo.getById('cut'))?.dropsFrom).toBe(1234);
        expect((yield* repo.getById('rename'))?.dropsFrom).toBeUndefined();

        yield* repo.setBefore('rename', eventRow('Before'));
        expect((yield* repo.getById('rename'))?.beforePayload?.title).toBe('Before');
        yield* repo.setBefore('rename', null);
        expect((yield* repo.getById('rename'))?.beforePayload).toBeNull();
      }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('a split-off series’ create keeps the series and occurrence it came from', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(
        op('split', { eventId: 'm2', kind: 'create', splitAt: 1234, splitIn: 'c1', splitOf: 'm1' }),
      );
      yield* repo.enqueue(op('plain', { eventId: 'm3', kind: 'create' }));
      const split = yield* repo.getById('split');
      expect([split?.splitOf, split?.splitIn, split?.splitAt, split?.splitCheck]).toEqual([
        'm1',
        'c1',
        1234,
        undefined,
      ]);
      const plain = yield* repo.getById('plain');
      expect([plain?.splitOf, plain?.splitAt]).toEqual([undefined, undefined]);

      yield* repo.setSplitCheck('split', true);
      expect((yield* repo.getById('split'))?.splitCheck).toBe(true);
      yield* repo.setSplitCheck('split', false);
      expect((yield* repo.getById('split'))?.splitCheck).toBeUndefined();

      yield* repo.moveSplits('acc-1', 'm1', 'c1', 'c2');
      expect((yield* repo.getById('split'))?.splitIn).toBe('c2');
      yield* repo.moveSplits('acc-1', 'm1', 'c1', 'c3');
      expect((yield* repo.getById('split'))?.splitIn).toBe('c2');
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('listDue hides ops whose backoff has not elapsed', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(op('ready', { nextAttemptAt: 1000 }));
      yield* repo.enqueue(op('waiting', { nextAttemptAt: 5000 }));

      expect((yield* repo.listDue(2000)).map((entry) => entry.id)).toEqual(['ready']);
      expect((yield* repo.listDue(9000)).map((entry) => entry.id).sort()).toEqual([
        'ready',
        'waiting',
      ]);
      // listAll ignores scheduling entirely.
      expect(yield* repo.listAll()).toHaveLength(2);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('a move survives content-edit coalescing and keeps its destination', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(op('upd', { eventId: 'evt-m' }));
      yield* repo.enqueue(
        op('mv', { createdAt: 2, eventId: 'evt-m', kind: 'move', targetCalendarId: 'cal-2' }),
      );
      yield* repo.removeForEvent('acc-1', 'cal-1', 'evt-m');

      const remaining = yield* repo.listAll();
      expect(remaining.map((entry) => entry.kind)).toEqual(['move']);
      expect(remaining[0]?.targetCalendarId).toBe('cal-2');
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('retarget rewrites an op in place, keeping its place in the queue', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      const before = new EventRecord({ ...eventRow('Before'), calendarId: 'cal-2' });
      yield* repo.enqueue(
        op('a', {
          attempts: 3,
          beforePayload: before,
          calendarId: 'cal-2',
          lastError: 'waiting for the move ahead of it',
          nextAttemptAt: 99,
          payload: new EventRecord({ ...eventRow('After'), calendarId: 'cal-2' }),
        }),
      );
      yield* repo.enqueue(op('b', { kind: 'move', targetCalendarId: 'cal-2' }));
      yield* repo.enqueue(op('c', { beforePayload: null, calendarId: 'cal-2' }));
      const [a, , c] = yield* repo.listAll();
      yield* repo.retarget(
        new PendingOp({
          ...a!,
          attempts: 0,
          beforePayload: new EventRecord({ ...before, calendarId: 'cal-1' }),
          calendarId: 'cal-1',
          lastError: undefined,
          nextAttemptAt: 0,
          payload: new EventRecord({ ...a!.payload!, calendarId: 'cal-1' }),
        }),
      );
      yield* repo.retarget(new PendingOp({ ...c!, calendarId: 'cal-1' }));

      const ops = yield* repo.listAll();
      expect(ops.map((entry) => `${entry.id}:${entry.calendarId}`)).toEqual([
        'a:cal-1',
        'b:cal-1',
        'c:cal-1',
      ]);
      expect(ops[0]).toMatchObject({ attempts: 0, nextAttemptAt: 0 });
      expect(ops[0]?.lastError).toBeUndefined();
      expect(ops[0]?.payload?.calendarId).toBe('cal-1');
      expect(ops[0]?.beforePayload?.calendarId).toBe('cal-1');
      expect(ops[0]?.beforePayload?.title).toBe('Before');
      expect(ops[2]?.beforePayload).toBeNull();
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('earlierInSeries sees older ops for the series in any calendar', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      const update = op('upd', { createdAt: 1, eventId: 'evt' });
      const instance = op('inst', { createdAt: 2, eventId: 'evt_20260714T090000Z' });
      const move = op('mv', { createdAt: 3, eventId: 'evt', kind: 'move' });
      const later = op('later', { calendarId: 'cal-2', createdAt: 4, eventId: 'evt' });
      yield* repo.enqueue(update);
      yield* repo.enqueue(instance);
      yield* repo.enqueue(move);
      yield* repo.enqueue(later);
      yield* repo.enqueue(op('other', { createdAt: 0, eventId: 'evt2' }));

      const kinds = (of: typeof update) =>
        Effect.map(repo.earlierInSeries(of), (earlier) => earlier.map((entry) => entry.kind));
      expect(yield* kinds(update)).toEqual([]);
      expect(yield* kinds(instance)).toEqual(['update']);
      expect(yield* kinds(move)).toEqual(['update', 'update']);
      expect(yield* kinds(later)).toEqual(['update', 'update', 'move']);
      expect((yield* repo.earlierInSeries(instance))[0]?.eventId).toBe('evt');
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('markFailed records the attempt, backoff and error', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(op('op-1'));
      yield* repo.markFailed('op-1', 3, 60_000, 'rate limited');

      const [stored] = yield* repo.listAll();
      expect(stored?.attempts).toBe(3);
      expect(stored?.nextAttemptAt).toBe(60_000);
      expect(stored?.lastError).toBe('rate limited');
      // Still queued, just not due yet.
      expect(yield* repo.listDue(59_999)).toHaveLength(0);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('remove and removeForEvent drop only what they target', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(op('a', { eventId: 'evt-1' }));
      yield* repo.enqueue(op('b', { eventId: 'evt-1', kind: 'delete' }));
      yield* repo.enqueue(op('c', { eventId: 'evt-2' }));

      yield* repo.remove('a');
      expect((yield* repo.listAll()).map((entry) => entry.id).sort()).toEqual(['b', 'c']);

      yield* repo.removeForEvent('acc-1', 'cal-1', 'evt-1');
      expect((yield* repo.listAll()).map((entry) => entry.id)).toEqual(['c']);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('removeForEvent leaves another account on the same shared calendar alone', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(op('mine', { eventId: 'evt-1' }));
      yield* repo.enqueue(op('theirs', { accountId: 'acc-2', eventId: 'evt-1' }));
      yield* repo.removeForEvent('acc-1', 'cal-1', 'evt-1');
      expect((yield* repo.listAll()).map((entry) => entry.id)).toEqual(['theirs']);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('advanceBaseEtag moves the followers built on the sent etag, not parked ones', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      // Queued before the op that landed (same instant, earlier row) and
      // long before: built without its change, so they keep their etag.
      yield* repo.enqueue(op('older', { baseEtag: '"v1"', createdAt: 0, eventId: 'evt-1' }));
      yield* repo.enqueue(op('tie', { baseEtag: '"v1"', eventId: 'evt-1' }));
      yield* repo.enqueue(op('landed', { baseEtag: '"v1"', eventId: 'evt-1' }));
      yield* repo.enqueue(op('same', { baseEtag: '"v1"', eventId: 'evt-1' }));
      yield* repo.enqueue(op('other', { baseEtag: '"v0"', eventId: 'evt-1' }));
      yield* repo.enqueue(op('parked', { baseEtag: '"v1"', eventId: 'evt-1' }));
      yield* repo.markConflict('parked', 5);
      yield* repo.enqueue(op('elsewhere', { baseEtag: '"v1"', eventId: 'evt-2' }));
      yield* repo.advanceBaseEtag(
        { accountId: 'acc-1', calendarId: 'cal-1', eventId: 'evt-1' },
        '"v1"',
        '"v2"',
        { createdAt: 1, id: 'landed' },
      );
      const etags = Object.fromEntries(
        (yield* repo.listAll()).map((entry) => [entry.id, entry.baseEtag]),
      );
      expect(etags).toEqual({
        elsewhere: '"v1"',
        landed: '"v1"',
        older: '"v1"',
        other: '"v0"',
        parked: '"v1"',
        same: '"v2"',
        tie: '"v1"',
      });
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('advanceBaseEtag after an op superseded in flight moves what shares its instant', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      // The landed op is gone: a later edit replaced it while it was sent.
      yield* repo.enqueue(op('replacement', { baseEtag: '"v1"', eventId: 'evt-1' }));
      yield* repo.advanceBaseEtag(
        { accountId: 'acc-1', calendarId: 'cal-1', eventId: 'evt-1' },
        '"v1"',
        '"v2"',
        { createdAt: 1, id: 'superseded' },
      );
      expect((yield* repo.getById('replacement'))?.baseEtag).toBe('"v2"');
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('listForEvent returns one event of one account, in queue order', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(op('second', { createdAt: 2, eventId: 'evt-1' }));
      yield* repo.enqueue(op('first', { createdAt: 1, eventId: 'evt-1' }));
      yield* repo.enqueue(op('other-account', { accountId: 'acc-2', eventId: 'evt-1' }));
      yield* repo.enqueue(op('other-calendar', { calendarId: 'cal-2', eventId: 'evt-1' }));
      yield* repo.enqueue(op('other-event', { eventId: 'evt-2' }));
      const ids = (yield* repo.listForEvent({
        accountId: 'acc-1',
        calendarId: 'cal-1',
        eventId: 'evt-1',
      })).map((entry) => entry.id);
      expect(ids).toEqual(['first', 'second']);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('retryNow makes waiting ops due, per account or all, but not parked ones', () =>
    Effect.gen(function* () {
      const repo = yield* PendingOpRepo;
      yield* repo.enqueue(op('a1', { attempts: 6, nextAttemptAt: 9000 }));
      yield* repo.enqueue(op('b1', { accountId: 'acc-2', nextAttemptAt: 9000 }));
      yield* repo.enqueue(op('parked', { nextAttemptAt: 9000 }));
      yield* repo.markConflict('parked', 5);

      yield* repo.retryNow('acc-1');
      expect((yield* repo.listDue(1)).map((entry) => entry.id)).toEqual(['a1']);
      // Attempts stay: the next failure backs off from where it was.
      expect((yield* repo.getById('a1'))?.attempts).toBe(6);

      yield* repo.retryNow();
      expect((yield* repo.listDue(1)).map((entry) => entry.id).sort()).toEqual(['a1', 'b1']);
    }).pipe(Effect.provide(freshDbLayer())),
  );
});
