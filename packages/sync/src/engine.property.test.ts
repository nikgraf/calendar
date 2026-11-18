import { unavailableAppleCalendarClient } from '@calendar/apple-calendar';
import { Account } from '@calendar/core';
import { AccountRepo, EventRepo, PendingOpRepo, reposLayer, runMigrations } from '@calendar/db';
import { GoogleCalendarClient, GooglePeopleClient, GoogleTasksClient } from '@calendar/google';
import { RemindersClient, unavailableRemindersClient } from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer, Schema } from 'effect';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { TestClock } from 'effect/testing';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import { SyncEngine } from './engine.ts';
import { EventMutations } from './mutations.ts';
import { FakeGoogle, type FakeFault } from './testing/fakeGoogle.ts';

const START = Date.parse('2026-08-24T10:00:00Z');
const ACCOUNT = 'property-account';
const CALENDAR = 'property-calendar';
const Index = Schema.Int.check(Schema.isBetween({ maximum: 20, minimum: 0 }));
const Title = Schema.String.check(Schema.isMaxLength(30), Schema.isPattern(/^[^\uD800-\uDFFF]*$/u));
const Command = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('create'), title: Title }),
  Schema.Struct({ index: Index, kind: Schema.Literal('edit'), title: Title }),
  Schema.Struct({ index: Index, kind: Schema.Literal('delete') }),
  Schema.Struct({
    fault: Schema.Literals(['none', 'refused', 'lost']),
    kind: Schema.Literal('retry'),
  }),
]);
type Command = typeof Command.Type;

const layerFor = (google: FakeGoogle) =>
  SyncEngine.layer.pipe(
    Layer.provideMerge(EventMutations.layer),
    Layer.provideMerge(appleCalendarServicesLayer(unavailableAppleCalendarClient('property test'))),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(RemindersClient, unavailableRemindersClient('property test'))),
    Layer.provideMerge(GoogleCalendarClient.layer),
    Layer.provideMerge(GoogleTasksClient.layer),
    Layer.provideMerge(GooglePeopleClient.layer),
    Layer.provideMerge(google.layer),
  );

interface ExpectedEvent {
  readonly endUtc: number;
  readonly id: string;
  readonly startUtc: number;
  readonly title: string;
}

const offline: NonNullable<FakeGoogle['fault']> = (call) =>
  call.method === 'GET' ? undefined : 'refused';

const scenario = (commands: ReadonlyArray<Command>) => {
  // New services for every evaluation, including every shrink attempt.
  const google = new FakeGoogle({
    calendars: [{ accessRole: 'owner', id: CALENDAR, primary: true, summary: 'Properties' }],
  });
  const expected = new Map<string, ExpectedEvent>();
  const lostWrites = new Set<string>();
  const faultsSeen = { lostCreate: 0, lostDelete: 0, refusedEdit: 0 };
  let armedFault: FakeFault | undefined;
  google.fault = offline;
  google.onAnswer = (call, answer) => {
    if (answer.lost && answer.status >= 200 && answer.status < 300) {
      if (
        call.method === 'POST' &&
        typeof answer.json === 'object' &&
        answer.json !== null &&
        'id' in answer.json &&
        typeof answer.json.id === 'string'
      ) {
        lostWrites.add(answer.json.id);
      } else if (call.method === 'PATCH' || call.method === 'DELETE') {
        lostWrites.add(decodeURIComponent(new URL(call.url).pathname.split('/').at(-1)!));
      }
    }
    if (armedFault === 'lost' && answer.lost && answer.status < 300 && call.method === 'POST') {
      faultsSeen.lostCreate += 1;
    }
    if (armedFault === 'lost' && answer.lost && answer.status === 204 && call.method === 'DELETE') {
      faultsSeen.lostDelete += 1;
    }
    if (armedFault === 'refused' && answer.status === 503 && call.method === 'PATCH') {
      faultsSeen.refusedEdit += 1;
    }
  };
  let serial = 0;

  return Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* (yield* AccountRepo).upsert(
      new Account({
        contactsEnabled: false,
        createdAt: START,
        email: 'properties@example.com',
        id: ACCOUNT,
        provider: 'google',
        status: 'ok',
        tasksEnabled: false,
      }),
    );
    const engine = yield* SyncEngine;
    const mutations = yield* EventMutations;
    const events = yield* EventRepo;
    const pending = yield* PendingOpRepo;
    yield* engine.syncAll();

    const settle = Effect.gen(function* () {
      // Mutations kick background drains. Let them reach the gate, then
      // join it before reading rows or changing the network policy.
      for (let round = 0; round < 3; round += 1) {
        yield* Effect.yieldNow;
        yield* mutations.whileQueueHeld(Effect.void);
      }
    });

    const retry = (fault: 'none' | FakeFault) =>
      Effect.gen(function* () {
        yield* settle;
        const hasWritableOp = (yield* pending.listAll()).some((op) => op.conflictAt === undefined);
        // One write is refused or lands with its response lost. Reads are
        // unaffected; later retries go through the real request/queue code.
        let remaining = fault === 'none' ? 0 : 1;
        armedFault = fault === 'none' ? undefined : fault;
        google.fault = (call) => {
          if (call.method === 'GET' || remaining === 0 || fault === 'none') {
            return undefined;
          }
          remaining -= 1;
          return fault;
        };
        // Arm before yielding to the clock: even a kicked drain must
        // encounter this policy, rather than a clean network.
        yield* TestClock.adjust('31 minutes');
        yield* mutations.processPendingOps();
        yield* settle;
        if (hasWritableOp && fault !== 'none') {
          expect(remaining).toBe(0);
        }
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            google.fault = offline;
            armedFault = undefined;
          }),
        ),
      );

    const apply = (command: Command) =>
      Effect.gen(function* () {
        if (command.kind === 'retry') {
          yield* retry(command.fault);
          yield* engine.syncAll();
          return;
        }
        if (command.kind === 'create') {
          const startUtc = START + serial++ * 3_600_000;
          const endUtc = startUtc + 1_800_000;
          const title = `Created: ${command.title}`;
          const record = yield* mutations.createEvent({
            accountId: ACCOUNT,
            calendarId: CALENDAR,
            endUtc,
            isAllDay: false,
            startTimeZone: 'UTC',
            startUtc,
            title,
          });
          expected.set(record.id, { endUtc, id: record.id, startUtc, title });
          return;
        }
        const ids = [...expected.keys()];
        const id = ids[command.index % ids.length];
        if (id === undefined) {
          return;
        }
        const target = { accountId: ACCOUNT, calendarId: CALENDAR, eventId: id };
        if (command.kind === 'delete') {
          yield* mutations.deleteEvent(target);
          expected.delete(id);
        } else {
          const title = `Edited: ${command.title}`;
          yield* mutations.updateEvent({ ...target, changes: { title } });
          expected.set(id, { ...expected.get(id)!, title });
        }
      });

    const assertLocalIntent = Effect.gen(function* () {
      const rows = (yield* events.getWindow(0, Number.MAX_SAFE_INTEGER)).singles;
      const ops = yield* pending.listAll();
      // A pull can echo a queued delete's server copy until DELETE is
      // acknowledged (dropPulledCopy removes it). Only that pending
      // removal may differ from intent; after draining there are none.
      const deleting = new Set(ops.filter((op) => op.kind === 'delete').map((op) => op.eventId));
      const projected = rows
        .filter((row) => !deleting.has(row.id))
        .map(({ endUtc, id, startUtc, title }) => ({
          endUtc,
          id,
          startUtc,
          title,
        }));
      expect(projected.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
        [...expected.values()].sort((a, b) => a.id.localeCompare(b.id)),
      );
      // A later edit/delete can meet our own lost PATCH on an old etag.
      // Only items whose writes actually landed unseen may be parked.
      for (const op of ops.filter((entry) => entry.conflictAt !== undefined)) {
        expect(lostWrites.has(op.eventId)).toBe(true);
      }
      for (const row of rows.filter((event) => event.syncStatus === 'pending')) {
        expect(ops.some((op) => op.eventId === row.id)).toBe(true);
      }
      const serverIds = google.eventsOf(CALENDAR).map((event) => event.id);
      expect(new Set(serverIds).size).toBe(serverIds.length);
    });
    const check = Effect.gen(function* () {
      yield* settle;
      yield* mutations.whileQueueHeld(assertLocalIntent);
    });

    // Every case exercises an ambiguous create and a retry before its
    // generated tail; a short or shrunk tail cannot make this vacuous.
    const prefix: ReadonlyArray<Command> = [
      { kind: 'create', title: 'Initial' },
      { fault: 'lost', kind: 'retry' },
      { fault: 'none', kind: 'retry' },
      { index: 0, kind: 'edit', title: 'Before retry' },
      { fault: 'refused', kind: 'retry' },
      { fault: 'none', kind: 'retry' },
      { index: 0, kind: 'delete' },
      { fault: 'lost', kind: 'retry' },
      { fault: 'none', kind: 'retry' },
      { kind: 'create', title: 'Survivor' },
    ];
    for (const command of prefix) {
      yield* apply(command);
      yield* check;
    }
    expect(faultsSeen.lostCreate).toBeGreaterThan(0);
    expect(faultsSeen.lostDelete).toBeGreaterThan(0);
    expect(faultsSeen.refusedEdit).toBeGreaterThan(0);
    for (const command of commands) {
      yield* apply(command);
      yield* check;
    }

    // With connectivity restored, choose the latest local intent for
    // conflicts caused by our lost writes, as a user choosing Keep mine.
    // Later drain/pull passes must not insert again or resurrect a delete.
    for (let pass = 0; pass < 3; pass += 1) {
      yield* check;
      const ops = yield* mutations.whileQueueHeld(pending.listAll());
      for (const op of ops.filter((entry) => entry.conflictAt !== undefined)) {
        yield* mutations.resolveConflict({ choice: 'mine', opId: op.id });
      }
      yield* retry('none');
      yield* engine.syncAll();
    }
    yield* check;
    expect(yield* pending.listAll()).toEqual([]);
    const server = google.eventsOf(CALENDAR).map((event) => ({
      endUtc: Date.parse(event.end!.dateTime!),
      id: event.id,
      startUtc: Date.parse(event.start!.dateTime!),
      title: event.summary,
    }));
    expect(server.sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...expected.values()].sort((a, b) => a.id.localeCompare(b.id)),
    );
  }).pipe(Effect.provide(layerFor(google)), Effect.scoped);
};

it.effect.each(['edit', 'delete'] as const)(
  'converges after a lost PATCH followed by another $0',
  (kind) =>
    scenario([
      { fault: 'none', kind: 'retry' },
      { index: 0, kind: 'edit', title: 'First edit' },
      { fault: 'lost', kind: 'retry' },
      kind === 'edit' ? { index: 0, kind, title: 'Second edit' } : { index: 0, kind },
      { fault: 'none', kind: 'retry' },
      // A parked conflict sends no write until a user resolves it.
      { fault: 'lost', kind: 'retry' },
      { fault: 'refused', kind: 'retry' },
    ]),
);

it.effect.prop(
  'generated create/edit/delete/retry sequences preserve intent and converge without duplicate events',
  { commands: Schema.Array(Command).check(Schema.isBetweenLength(1, 30)) },
  ({ commands }) => scenario(commands),
  {
    arbitrary: {
      ...(process.env['SYNC_PROPERTY_REPLAY']
        ? { replay: process.env['SYNC_PROPERTY_REPLAY'] }
        : {}),
      runs: 40,
      size: 30,
    },
    timeout: 60_000,
  },
);
