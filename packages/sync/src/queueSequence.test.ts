import { unavailableAppleCalendarClient } from '@calendar/apple-calendar';
import {
  Account,
  Attendee,
  type EventInstance,
  expandRecurringEvent,
  failureText,
  googleInstanceId,
  type PendingOp,
  type RecurrenceMaster,
  recurrenceMasterOf,
} from '@calendar/core';
import { AccountRepo, PendingOpRepo, reposLayer, runMigrations } from '@calendar/db';
import {
  type GcalEvent,
  type GcalTask,
  GoogleCalendarClient,
  GooglePeopleClient,
  GoogleTasksClient,
  mapGcalEvent,
  mapGcalTask,
} from '@calendar/google';
import { RemindersClient, unavailableRemindersClient } from '@calendar/reminders';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer, Result, Scheduler } from 'effect';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { SqlClient } from 'effect/sql/SqlClient';
import { TestClock } from 'effect/testing';
import { describe, vi } from 'vite-plus/test';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import { SyncEngine, type SyncEngineShape } from './engine.ts';
import type { EventMutationsShape } from './mutationTypes.ts';
import { EventMutations } from './mutations.ts';
import { type FakeCall, type FakeFault, FakeGoogle } from './testing/fakeGoogle.ts';

/**
 * Seeded random sequences over the pending-op queue, against the fake
 * Google: a user edits, creates, deletes and moves events and tasks and
 * discards queued changes; the network lands writes, loses their answers
 * or refuses them; another device edits and deletes; pulls land in
 * between. After every step, with no drain running:
 *
 * 1. every pending row is owned by a queued op;
 * 2. (at the end) after a full drain and a pull, the rows equal Google's,
 *    and what the user did last to an item nobody else touched is what
 *    Google has;
 * 3. what Google last told the client about an item no op owns is what
 *    the client shows (a discard leaves Google's version showing), and a
 *    synced row at Google's current etag has Google's content;
 * 4. no write meets a 404 or another refusal unless another device, or a
 *    write of ours whose answer was lost, removed the item: an op sent
 *    before what it depends on (a move before its edit, an edit before its
 *    create or after its move) meets one; and no op parks a conflict on an
 *    item nobody else changed.
 *
 * Series are in: the user creates one, edits or deletes one occurrence,
 * edits all events (their text, or the time of a series without
 * exceptions), gives it another rule, edits "this and following", deletes
 * it, moves it; another device renames or deletes a series, changes or
 * cancels an occurrence. A series is judged by what it draws: every
 * occurrence is an item under Google's id for it (`<masterId>_<original
 * start>`), an exception by its own row and a plain one by its master's
 * rule, on the client as on Google (`events.instances`). The sequences
 * stay on what is recorded of Google (docs/google-sync-and-testing.md,
 * Events & recurrence): a series with exceptions is not retimed, no rule
 * draws a slot again that an earlier one dropped, nobody edits an
 * occurrence Google holds cancelled, nothing is done to a series on the
 * etag one of its exceptions had before the series moved — and the fake's
 * `unverified` stays empty, or the sequence fails as one that left that
 * ground. What a list reports for the exceptions of a series that left a
 * calendar is not recorded either: what the client then shows of them is
 * not judged (World.unjudged).
 *
 * A failing seed prints its whole sequence; rerun it alone with
 * `QUEUE_SEQUENCE_SEED=<seed> pnpm exec vp test run packages/sync/src/queueSequence.test.ts`
 * (`QUEUE_SEQUENCE_RUNS` and `QUEUE_SEQUENCE_STEPS` widen the search).
 */

const ACCOUNT_ID = 'acc-1';
const EMAIL = 'sequence@example.com';
const CALENDARS = ['cal-1', 'cal-2'] as const;
const LISTS = ['list-1', 'list-2'] as const;
/** The fake's own clock; the TestClock starts here too. */
const START = Date.parse('2026-08-24T10:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** The days every series is compared over: further than any rule here reaches. */
const WINDOW_FROM = START - 2 * DAY;
const WINDOW_TO = START + 60 * DAY;

const envNumber = (name: string): number | undefined => {
  const raw = process.env[name];
  return raw === undefined || raw === '' ? undefined : Number(raw);
};

const SEEDS: ReadonlyArray<number> = (() => {
  const one = envNumber('QUEUE_SEQUENCE_SEED');
  if (one !== undefined) {
    return [one];
  }
  return Array.from({ length: envNumber('QUEUE_SEQUENCE_RUNS') ?? 50 }, (_, index) => index + 1);
})();
const STEPS = envNumber('QUEUE_SEQUENCE_STEPS') ?? 40;
/** Every step's requests in the report, not only the failing step's. */
const VERBOSE = process.env['QUEUE_SEQUENCE_VERBOSE'] === '1';
/** Run the seeds KNOWN_FAILING skips (to check a change that closes their gap). */
const RUN_KNOWN = process.env['QUEUE_SEQUENCE_KNOWN'] === '1';

const noYield = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.provideService(effect, Scheduler.MaxOpsBeforeYield, Number.MAX_SAFE_INTEGER);

/** mulberry32: small, fast and the same on every machine. */
const seededRandom = (seed: number): (() => number) => {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d_2b_79_f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
};

const pick = <A>(random: () => number, items: ReadonlyArray<A>): A | undefined =>
  items.length === 0 ? undefined : items[Math.floor(random() * items.length)];

/**
 * Event and op ids come from `crypto.getRandomValues`: seeded here, a
 * failing sequence replays with the same ids.
 */
const withSeededIds =
  (seed: number) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        const random = seededRandom(seed ^ 0x5e_ed);
        return vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation(((
          array: ArrayBufferView | null,
        ) => {
          if (array !== null) {
            const bytes = new Uint8Array(array.buffer, array.byteOffset, array.byteLength);
            for (let index = 0; index < bytes.length; index += 1) {
              bytes[index] = Math.floor(random() * 256);
            }
          }
          return array;
        }) as Crypto['getRandomValues']);
      }),
      () => effect,
      (spy) => Effect.sync(() => spy.mockRestore()),
    );

const iso = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

const timed = (id: string, day: number, hour: number, summary: string): GcalEvent => ({
  end: { dateTime: iso(START + day * DAY + (hour + 1) * HOUR) },
  id,
  organizer: { email: EMAIL, self: true },
  start: { dateTime: iso(START + day * DAY + hour * HOUR) },
  status: 'confirmed',
  summary,
});

/** A daily series of `count`, UTC as the live suite's (an instance id carries the UTC instant). */
const daily = (
  id: string,
  day: number,
  hour: number,
  count: number,
  summary: string,
): GcalEvent => ({
  ...timed(id, day, hour, summary),
  end: { dateTime: iso(START + day * DAY + (hour + 1) * HOUR), timeZone: 'UTC' },
  recurrence: [`RRULE:FREQ=DAILY;COUNT=${count}`],
  start: { dateTime: iso(START + day * DAY + hour * HOUR), timeZone: 'UTC' },
});

const due = (day: number): string =>
  `${new Date(START + day * DAY).toISOString().slice(0, 10)}T00:00:00.000Z`;

/** The fake the sequences run against; `cal-3` only for a scripted test that needs three. */
const newFake = (options: { readonly thirdCalendar?: boolean } = {}): FakeGoogle => {
  const google = new FakeGoogle({
    calendars: [
      { accessRole: 'owner', id: 'cal-1', primary: true, summary: 'Personal' },
      { accessRole: 'owner', id: 'cal-2', summary: 'Work' },
      ...(options.thirdCalendar === true
        ? [{ accessRole: 'owner', id: 'cal-3', summary: 'Family' }]
        : []),
    ],
    organizerEmail: EMAIL,
    taskLists: [
      { id: 'list-1', title: 'My Tasks' },
      { id: 'list-2', title: 'Errands' },
    ],
  });
  google.putEvent('cal-1', timed('e1', 1, 9, 'Standup'));
  google.putEvent('cal-1', timed('e2', 2, 11, 'Lunch'));
  google.putEvent('cal-2', timed('e3', 3, 14, 'Review'));
  google.putEvent('cal-1', daily('r1', 2, 5, 6, 'Yoga'));
  // One with exceptions already: its second occurrence three hours later,
  // its third cancelled.
  google.putEvent('cal-2', daily('r2', 4, 1, 5, 'Sprint'));
  const second = START + 5 * DAY + HOUR;
  google.patchEventServerSide('cal-2', googleInstanceId('r2', second, false), {
    end: { dateTime: iso(second + 4 * HOUR), timeZone: 'UTC' },
    start: { dateTime: iso(second + 3 * HOUR), timeZone: 'UTC' },
  });
  google.deleteEventServerSide('cal-2', googleInstanceId('r2', second + DAY, false));
  google.putTask('list-1', {
    due: due(5),
    id: 'p',
    position: '00000000000000000000',
    title: 'Trip',
  });
  google.putTask('list-1', {
    due: due(5),
    id: 's1',
    parent: 'p',
    position: '00000000000000000000',
    title: 'Pack',
  });
  google.putTask('list-1', {
    due: due(5),
    id: 's2',
    parent: 'p',
    position: '00000000000000000001',
    title: 'Book',
  });
  google.putTask('list-1', {
    due: due(6),
    id: 't1',
    position: '00000000000000000001',
    title: 'Rent',
  });
  google.putTask('list-2', {
    due: due(7),
    id: 't2',
    position: '00000000000000000000',
    title: 'Call',
  });
  return google;
};

const layerFor = (google: FakeGoogle) =>
  SyncEngine.layer.pipe(
    Layer.provideMerge(EventMutations.layer),
    Layer.provideMerge(appleCalendarServicesLayer(unavailableAppleCalendarClient('test'))),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
    Layer.provideMerge(Layer.succeed(RemindersClient, unavailableRemindersClient('test'))),
    Layer.provideMerge(GoogleCalendarClient.layer),
    Layer.provideMerge(GoogleTasksClient.layer),
    Layer.provideMerge(GooglePeopleClient.layer),
    Layer.provideMerge(google.layer),
  );

// ---- what the client shows, what Google has ----

interface EventRow {
  readonly calendar_id: string;
  readonly description: string | null;
  readonly end_utc: number;
  readonly etag: string | null;
  readonly id: string;
  readonly is_all_day: number;
  readonly location: string | null;
  readonly original_start_utc: number | null;
  /** The rule lines, a JSON array. */
  readonly recurrence: string | null;
  readonly recurring_event_id: string | null;
  readonly start_time_zone: string | null;
  readonly start_utc: number;
  readonly status: string;
  readonly sync_status: string;
  readonly title: string;
}

interface TaskRow {
  readonly due_date: string | null;
  readonly id: string;
  readonly list_id: string;
  readonly notes: string | null;
  readonly parent_id: string | null;
  readonly status: string;
  readonly sync_status: string;
  readonly title: string;
}

/** The fields an item shows, as text: what the checks compare. */
type Fields = Readonly<Record<string, string>>;

const recurrenceOf = (row: EventRow): ReadonlyArray<string> =>
  row.recurrence === null ? [] : (JSON.parse(row.recurrence) as ReadonlyArray<string>);

const eventRowFields = (row: EventRow): Fields => ({
  allDay: String(row.is_all_day === 1),
  description: row.description ?? '',
  end: String(row.end_utc),
  location: row.location ?? '',
  repeat: recurrenceOf(row).join('\n'),
  start: String(row.start_utc),
  title: row.title,
});

const gcalEventFields = (calendarId: string, event: GcalEvent): Fields | undefined => {
  const record = mapGcalEvent(event, {
    accountId: ACCOUNT_ID,
    calendarId,
    defaultTimeZone: 'UTC',
    syncedAt: 0,
  });
  return record === null
    ? undefined
    : {
        allDay: String(record.isAllDay),
        description: record.description ?? '',
        end: String(record.endUtc),
        location: record.location ?? '',
        repeat: (record.recurrence ?? []).join('\n'),
        start: String(record.startUtc),
        title: record.title,
      };
};

const taskRowFields = (row: TaskRow): Fields => ({
  due: row.due_date ?? '',
  notes: row.notes ?? '',
  parent: row.parent_id ?? '',
  status: row.status,
  title: row.title,
});

const gcalTaskFields = (listId: string, task: GcalTask): Fields | undefined => {
  const record = mapGcalTask(task, { accountId: ACCOUNT_ID, taskListId: listId });
  return record === null
    ? undefined
    : {
        due: record.dueDate ?? '',
        notes: record.notes ?? '',
        parent: record.parentId ?? '',
        status: record.status,
        title: record.title,
      };
};

const sameFields = (left: Fields, right: Fields): boolean =>
  Object.keys(left).length === Object.keys(right).length &&
  Object.entries(left).every(([key, value]) => right[key] === value);

const showFields = (fields: Fields): string =>
  Object.entries(fields)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(' ');

interface Snapshot {
  /** Google's copies of the tasks a queued change holds (`task_copies`). */
  readonly copies: ReadonlyArray<{
    readonly id: string;
    readonly list_id: string;
    readonly parent: string | null;
  }>;
  readonly events: ReadonlyArray<EventRow>;
  readonly ops: ReadonlyArray<PendingOp>;
  readonly tasks: ReadonlyArray<TaskRow>;
}

const EVENT_KINDS: ReadonlySet<PendingOp['kind']> = new Set([
  'create',
  'delete',
  'move',
  'rsvp',
  'update',
]);

/** `<masterId>_<original start>`: one occurrence of a series (the series here are timed). */
const OCCURRENCE_ID = /^(.+)_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/;

/** The series an occurrence's id names; undefined for any other id. */
const masterIdOf = (id: string): string | undefined => OCCURRENCE_ID.exec(id)?.[1];

const isOccurrenceOf = (id: string, masterId: string): boolean => masterIdOf(id) === masterId;

/** The original start an occurrence's id names. */
const slotOfId = (id: string): number | undefined => {
  const match = OCCURRENCE_ID.exec(id);
  if (!match) {
    return undefined;
  }
  const [year, month, day, hour, minute, second] = match.slice(2).map(Number);
  return Date.UTC(year ?? 0, (month ?? 1) - 1, day, hour, minute, second);
};

/**
 * Whether the op holds this event row: its own, or the one its move put
 * in the target — a series' move puts its exceptions there too.
 */
const ownsEvent = (op: PendingOp, calendarId: string, eventId: string): boolean =>
  EVENT_KINDS.has(op.kind) &&
  ((op.eventId === eventId &&
    (op.calendarId === calendarId || (op.kind === 'move' && op.targetCalendarId === calendarId))) ||
    (op.kind === 'move' &&
      op.targetCalendarId === calendarId &&
      isOccurrenceOf(eventId, op.eventId)));

// ---- what a series draws ----

const isSingle = (row: EventRow): boolean =>
  row.status !== 'cancelled' && row.recurring_event_id === null && recurrenceOf(row).length === 0;

const isMaster = (row: EventRow): boolean =>
  row.status !== 'cancelled' && row.recurring_event_id === null && recurrenceOf(row).length > 0;

/** What the expansion reads of a master row, under `recurrence` (its own unless given). */
const ruleMaster = (
  row: EventRow,
  recurrence: ReadonlyArray<string> = recurrenceOf(row),
): RecurrenceMaster => ({
  endUtc: row.end_utc,
  id: row.id,
  isAllDay: false,
  recurrence,
  startTimeZone: row.start_time_zone ?? 'UTC',
  startUtc: row.start_utc,
});

/** The occurrences a rule draws in the window but `taken`; none when it does not expand. */
const drawnBy = (master: RecurrenceMaster, taken?: ReadonlySet<number>): Array<EventInstance> => {
  try {
    return expandRecurringEvent(master, WINDOW_FROM, WINDOW_TO, taken);
  } catch {
    return [];
  }
};

/** Whether the rule draws an occurrence at `slot`. */
const drawsAt = (master: RecurrenceMaster, slot: number): boolean => {
  try {
    return expandRecurringEvent(master, slot - 1, slot + 1).some(
      (instance) => instance.originalStartUtc === slot,
    );
  } catch {
    return false;
  }
};

interface Occurrence {
  readonly end: number;
  /** Google's id for it, whether or not a row exists. */
  readonly id: string;
  /** Its exception row, when it was changed on its own. */
  readonly row: EventRow | undefined;
  /** Its original start. */
  readonly slot: number;
  readonly start: number;
}

/** A series as the client has it: the master row, its exception rows, and what it draws. */
interface ClientSeries {
  readonly master: EventRow;
  /** In slot order; a cancelled occurrence is not among them. */
  readonly occurrences: ReadonlyArray<Occurrence>;
  /** Its exception rows, cancelled ones included. */
  readonly overrides: ReadonlyArray<EventRow>;
}

const clientSeries = (events: ReadonlyArray<EventRow>): Array<ClientSeries> =>
  events.filter(isMaster).map((master) => {
    const overrides = events.filter(
      (row) => row.calendar_id === master.calendar_id && row.recurring_event_id === master.id,
    );
    const taken = new Set(
      overrides.flatMap((row) => (row.original_start_utc === null ? [] : [row.original_start_utc])),
    );
    const occurrences: Array<Occurrence> = [
      ...drawnBy(ruleMaster(master), taken).map((instance) => ({
        end: instance.endUtc,
        id: googleInstanceId(master.id, instance.originalStartUtc, false),
        row: undefined,
        slot: instance.originalStartUtc,
        start: instance.startUtc,
      })),
      ...overrides
        .filter((row) => row.status !== 'cancelled')
        .map((row) => ({
          end: row.end_utc,
          id: row.id,
          row,
          slot: row.original_start_utc ?? row.start_utc,
          start: row.start_utc,
        })),
    ];
    return { master, occurrences: occurrences.sort((a, b) => a.slot - b.slot), overrides };
  });

/**
 * What a calendar shows, by id: its single events, its series' masters
 * (with their rule) and every occurrence a series draws.
 */
type View = ReadonlyMap<string, Fields>;

const clientView = (events: ReadonlyArray<EventRow>, calendarId: string): View => {
  const view = new Map<string, Fields>();
  for (const row of events) {
    if (row.calendar_id === calendarId && row.status !== 'cancelled') {
      view.set(row.id, eventRowFields(row));
    }
  }
  for (const { master, occurrences } of clientSeries(events)) {
    for (const occurrence of occurrences) {
      if (master.calendar_id === calendarId && occurrence.row === undefined) {
        view.set(occurrence.id, {
          ...eventRowFields(master),
          end: String(occurrence.end),
          repeat: '',
          start: String(occurrence.start),
        });
      }
    }
  }
  return view;
};

const googleView = (google: FakeGoogle, calendarId: string): View => {
  const view = new Map<string, Fields>();
  for (const event of google.eventsOf(calendarId)) {
    const fields = gcalEventFields(calendarId, event);
    if (fields !== undefined) {
      view.set(event.id, fields);
    }
    for (const instance of google.instancesOf(calendarId, event.id, WINDOW_FROM, WINDOW_TO)) {
      const drawn = gcalEventFields(calendarId, instance);
      if (drawn !== undefined) {
        view.set(instance.id, drawn);
      }
    }
  }
  return view;
};

/** Both sides' views of a moment, each calendar's computed once. */
interface Views {
  readonly client: (calendarId: string) => View;
  readonly google: (calendarId: string) => View;
}

const memoized = (compute: (calendarId: string) => View) => {
  const known = new Map<string, View>();
  return (calendarId: string): View => {
    const view = known.get(calendarId) ?? compute(calendarId);
    known.set(calendarId, view);
    return view;
  };
};

const viewsOf = (google: FakeGoogle, events: ReadonlyArray<EventRow>): Views => ({
  client: memoized((calendarId) => clientView(events, calendarId)),
  google: memoized((calendarId) => googleView(google, calendarId)),
});

/** Whether the op holds this task row: its own, or one its move carries (the task, its subtasks). */
const ownsTask = (
  op: PendingOp,
  listId: string,
  task: { readonly id: string; readonly parent: string | undefined },
): boolean =>
  !EVENT_KINDS.has(op.kind) &&
  op.kind !== 'calendarColor' &&
  ((op.calendarId === listId && op.eventId === task.id) ||
    (op.kind === 'moveTask' &&
      (op.calendarId === listId || op.targetTaskListId === listId) &&
      (op.eventId === task.id || op.eventId === task.parent)));

const describeOp = (op: PendingOp): string =>
  `${op.kind} ${op.eventId} in ${op.calendarId}` +
  ((op.targetCalendarId ?? op.targetTaskListId)
    ? ` → ${op.targetCalendarId ?? op.targetTaskListId}`
    : '') +
  (op.conflictAt === undefined ? '' : ' (parked)') +
  (op.dispatchedAt === undefined ? '' : ' (sent)') +
  (op.attempts > 0 ? ` (${op.attempts} failed)` : '');

// ---- the world the sequence runs in ----

/** What the user did last to an item, while nobody else touched it since. */
type Intent =
  | { readonly kind: 'deleted' }
  | { readonly container: string | undefined; readonly fields: Fields; readonly kind: 'set' };

interface Told {
  /** Google's copy as it was told, or null: told deleted. */
  readonly item: GcalEvent | GcalTask | null;
  readonly json: string;
}

interface World {
  /** The subtasks of the task the request in flight deletes or moves, read before Google answers it. */
  children: ReadonlyArray<string>;
  /** Series the answer to a delete of ours said are gone: Google took their occurrences. */
  readonly deletedSeries: Set<string>;
  /** The same as `calendar|id`: where the client knows it from its own delete, not from a list. */
  readonly deletedSlots: Set<string>;
  /** Items another device changed, or a write of ours whose answer was lost touched. */
  readonly disturbed: Set<string>;
  /** The etag each exception row had when the user last moved its series (see movedSincePulled). */
  readonly etagsAtMove: Map<string, string>;
  readonly google: FakeGoogle;
  /**
   * Slots (`container|id`) Google sent this step, with the copy last sent
   * (JSON, `null` for gone) and whether an answer the client applies
   * carried it.
   */
  readonly heard: Map<
    string,
    { readonly applied: boolean; readonly json: string; readonly shownOnly: boolean }
  >;
  /** Items an op held at the end of the step before (see heldItems). */
  held: ReadonlySet<string>;
  /**
   * Items Google showed the client a newer state of while an op held
   * their row, in an answer the client keeps nothing of: an event it
   * asked for by id (the fetch after a 412 when the op has left the queue
   * by then, a split-off series asking where its source ends), or a task
   * listing, which may be the drain looking for a create whose answer was
   * lost. The next pull brings that state, so until then a difference is
   * listed, not failed — per slot, what that copy shows (JSON), while
   * Google's still shows it. A pull's events page is no such answer: what
   * it brings for a held event becomes the event's copy, and shows once
   * the op is gone.
   */
  readonly heldTold: Map<string, string>;
  readonly intents: Map<string, Intent>;
  readonly knownGaps: Array<string>;
  network: { readonly lost: number; readonly name: string; readonly refused: number };
  /** Faults the next writes meet, in order, before the network's odds apply. */
  readonly nextWrites: Array<FakeFault>;
  readonly random: () => number;
  /** Items another device removed, or a lost delete or move of ours took away: a 404 there is no surprise. */
  readonly removed: Set<string>;
  /**
   * Series a PATCH of ours changed with its answer lost: a new rule or a
   * cut may have taken occurrences away behind the client's back, so a
   * 404 or 410 at one of them is no surprise either.
   */
  readonly reshaped: Set<string>;
  /**
   * Series a PATCH of ours reached, answered or not: Google gave each of
   * their exceptions a new etag (verified live), which the client's rows
   * learn at the next pull. A delete of such an occurrence that goes on
   * the old etag is parked, by decision: a DELETE takes along what the
   * app does not keep, so it asks whenever the version moved
   * (docs/architecture.md, 412 Conflict).
   */
  readonly retagged: Set<string>;
  /**
   * The series a this-and-following edit split off, by id, with the id of
   * the series it was split from: it lands, or goes, with that one's cut.
   */
  readonly splitSources: Map<string, string>;
  step: number;
  /** Requests this step, for the report. */
  stepLog: Array<string>;
  /** What Google last told the client, per `container|id`: answers it applies. */
  readonly told: Map<string, Told>;
  readonly trace: Array<string>;
  /**
   * Series whose cut may have been undone since (a rule that draws past it
   * again, a discarded or given-up change): the app then takes back what
   * was split off there, and what was split off that in turn.
   */
  readonly uncut: Set<string>;
  /**
   * Series (`calendar|id`) a list named gone, with the live exceptions
   * they took along, where the client had not deleted the series itself.
   * What a list reports for those exceptions is not recorded
   * (FakeGoogle.goneWithExceptions), so what the client then shows of
   * them in that calendar is not judged. A delete of its own it settles
   * itself; a move of its own takes the rows it has along, and one it
   * left behind (a pull's, under a rule cleared offline) is the list's.
   */
  readonly unjudged: Set<string>;
  /** Items deleted on Google behind the user's back (another device, a lost delete of ours): no later edit keeps them. */
  readonly vanished: Set<string>;
  readonly violations: Array<string>;
}

const eventKey = (id: string): string => `event:${id}`;
const taskKey = (id: string): string => `task:${id}`;

/** The series an occurrence's key belongs to, as a key; undefined for any other item. */
const seriesKeyOf = (key: string): string | undefined => {
  const masterId = key.startsWith('event:') ? masterIdOf(key.slice('event:'.length)) : undefined;
  return masterId === undefined ? undefined : eventKey(masterId);
};

/**
 * Whether the set names the item or, for an occurrence, its series: what
 * happens to a series on Google happens to every occurrence of it.
 */
const touches = (set: ReadonlySet<string>, key: string): boolean => {
  const series = seriesKeyOf(key);
  return set.has(key) || (series !== undefined && set.has(series));
};

/** The item a request addresses: `{ key, container }`, or undefined for a list or a create. */
const itemOf = (
  call: FakeCall,
): { readonly container: string; readonly id: string; readonly key: string } | undefined => {
  const path = new URL(call.url).pathname;
  const event = /^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)(?:\/move)?$/.exec(path);
  if (event) {
    const id = decodeURIComponent(event[2]!);
    return { container: decodeURIComponent(event[1]!), id, key: eventKey(id) };
  }
  const task = /^\/tasks\/v1\/lists\/([^/]+)\/tasks\/([^/]+)(?:\/move)?$/.exec(path);
  if (task) {
    const id = decodeURIComponent(task[2]!);
    return { container: decodeURIComponent(task[1]!), id, key: taskKey(id) };
  }
  return undefined;
};

/** A request as the report shows it: method, path and the parameters that matter. */
const showCall = (call: FakeCall): string => {
  const url = new URL(call.url);
  const params = [
    'syncToken',
    'destination',
    'destinationTasklist',
    'updatedMin',
    'parent',
    'previous',
  ]
    .filter((name) => url.searchParams.has(name))
    .map((name) => `${name}=${url.searchParams.get(name)}`);
  return `${call.method} ${url.pathname}${params.length > 0 ? `?${params.join('&')}` : ''}`;
};

const isListRead = (call: FakeCall): boolean => call.method === 'GET' && itemOf(call) === undefined;

const isCalendar = (container: string): boolean =>
  (CALENDARS as ReadonlyArray<string>).includes(container);

/** The item a `container|id` slot holds. */
const keyOfSlot = (slot: string): string => {
  const [container = '', id = ''] = slot.split('|');
  return isCalendar(container) ? eventKey(id) : taskKey(id);
};

/** What the client would show of Google's copy (JSON; `null` for none): a renumbered position is no change. */
const shownJson = (container: string, item: GcalEvent | GcalTask | null): string =>
  JSON.stringify(
    item === null
      ? null
      : isCalendar(container)
        ? (gcalEventFields(container, item) ?? null)
        : (gcalTaskFields(container, item) ?? null),
  );

const remember = (
  world: World,
  container: string,
  id: string,
  item: GcalEvent | GcalTask | null,
  applied: boolean,
  shownOnly = false,
) => {
  const slot = `${container}|${id}`;
  world.heard.set(slot, {
    applied: applied || (world.heard.get(slot)?.applied ?? false),
    json: shownJson(container, item),
    shownOnly,
  });
  if (applied) {
    world.told.set(slot, { item, json: JSON.stringify(item) });
    // A series back in the calendar (moved back) is judged again.
    if (item !== null) {
      world.unjudged.delete(slot);
    }
  }
};

/**
 * The answer to a delete of the client's own said the series is gone: it
 * took its exceptions along, and the client knows.
 */
const toldGone = (world: World, container: string, id: string) => {
  for (const slot of world.told.keys()) {
    const [where = '', otherId = ''] = slot.split('|');
    if (where === container && isOccurrenceOf(otherId, id)) {
      world.told.set(slot, { item: null, json: 'null' });
    }
  }
};

/** What a 2xx tells the client about the items it carries. */
const learn = (world: World, call: FakeCall, status: number, json: unknown) => {
  const url = new URL(call.url);
  const path = url.pathname;
  const target = itemOf(call);
  const body = json as {
    readonly id?: string;
    readonly items?: ReadonlyArray<GcalEvent & GcalTask>;
  };
  if (target === undefined) {
    const events = /^\/calendar\/v3\/calendars\/([^/]+)\/events$/.exec(path);
    const tasks = /^\/tasks\/v1\/lists\/([^/]+)\/tasks$/.exec(path);
    const container = events?.[1] ?? tasks?.[1];
    if (container === undefined || url.searchParams.has('fields')) {
      return;
    }
    const calendarOrList = decodeURIComponent(container);
    if (call.method === 'GET') {
      // An events page is a pull, applied wherever no op holds the row. A
      // task listing may be one too, or the drain looking for a create
      // whose answer was lost, which applies nothing: it only counts as
      // a copy sent while held.
      //
      // A series this page names gone that took live exceptions along:
      // unless the client deleted it itself, what it makes of those
      // exceptions is the list's to say, and not judged.
      const tookExceptions = new Set(world.google.goneWithExceptions.splice(0));
      for (const item of body.items ?? []) {
        const gone = item.status === 'cancelled' || item.deleted === true;
        const slot = `${calendarOrList}|${item.id}`;
        if (gone && tookExceptions.has(slot) && !world.deletedSlots.has(slot)) {
          world.unjudged.add(slot);
        }
        remember(
          world,
          calendarOrList,
          item.id,
          gone ? null : item,
          events !== null,
          events === null,
        );
      }
      // A full events list (after a 410) says gone by leaving out: what it
      // does not name, it no longer has (one page here).
      if (events !== null && !url.searchParams.has('syncToken')) {
        const named = new Set((body.items ?? []).map((item) => item.id));
        for (const slot of world.told.keys()) {
          const [container = '', id = ''] = slot.split('|');
          if (container === calendarOrList && !named.has(id)) {
            remember(world, container, id, null, true);
          }
        }
      }
    } else if (body.id !== undefined) {
      remember(world, calendarOrList, body.id, json as GcalEvent, true);
    }
    return;
  }
  if (call.method === 'DELETE') {
    remember(world, target.container, target.id, null, true);
    if (target.key.startsWith('event:') && masterIdOf(target.id) === undefined) {
      toldGone(world, target.container, target.id);
      world.deletedSeries.add(target.key);
      world.deletedSlots.add(`${target.container}|${target.id}`);
    }
    return;
  }
  const destination =
    url.searchParams.get('destination') ?? url.searchParams.get('destinationTasklist');
  if (status === 200) {
    // An event the client asks for while no op of its own holds it is only
    // looked at (a split-off series asking where its source ends), not
    // written to the row.
    const applied = call.method !== 'GET' || isHeld(world.held, target.key);
    remember(
      world,
      destination ?? target.container,
      target.id,
      json as GcalEvent,
      applied,
      call.method === 'GET',
    );
    if (url.searchParams.has('destination')) {
      // The event left its calendar: the answer to the move says so.
      world.told.set(`${target.container}|${target.id}`, { item: null, json: 'null' });
    }
  }
};

const makeWorld = (seed: number, google: FakeGoogle): World => {
  const random = seededRandom(seed);
  const world: World = {
    children: [],
    deletedSeries: new Set(),
    deletedSlots: new Set(),
    disturbed: new Set(),
    etagsAtMove: new Map(),
    google,
    heard: new Map(),
    held: new Set(),
    heldTold: new Map(),
    intents: new Map(),
    knownGaps: [],
    network: { lost: 0, name: 'good', refused: 0 },
    nextWrites: [],
    random,
    removed: new Set(),
    reshaped: new Set(),
    retagged: new Set(),
    splitSources: new Map(),
    step: 0,
    stepLog: [],
    told: new Map(),
    trace: [],
    uncut: new Set(),
    unjudged: new Set(),
    vanished: new Set(),
    violations: [],
  };
  google.fault = (call) => {
    if (isListRead(call)) {
      return undefined;
    }
    const scripted = call.method === 'GET' ? undefined : world.nextWrites.shift();
    // Google deletes (and moves) a parent's subtasks with it: which they
    // are can only be read before it answers.
    const target = itemOf(call);
    world.children =
      target?.key.startsWith('task:') === true
        ? LISTS.flatMap((list) =>
            google.tasksIn(list).filter((task) => task.parent === target.id),
          ).map((task) => task.id)
        : [];
    const roll = random();
    const fault =
      scripted ??
      (roll < world.network.refused
        ? 'refused'
        : roll < world.network.refused + world.network.lost
          ? 'lost'
          : undefined);
    return fault;
  };
  google.onAnswer = (call, { json, lost, status }) => {
    world.stepLog.push(`${showCall(call)} → ${status}${lost ? ', the answer lost' : ''}`);
    if (call.method === 'PATCH' && status >= 200 && status < 300) {
      const patched = itemOf(call)?.key;
      if (patched?.startsWith('event:') === true) {
        world.retagged.add(patched);
      }
    }
    if (lost) {
      if (call.method !== 'GET' && status >= 200 && status < 300) {
        lostLanded(world, call);
      }
      return;
    }
    if (status >= 200 && status < 300) {
      learn(world, call, status, json);
      return;
    }
    if (call.method === 'GET' || status === 409 || status === 412 || status >= 500) {
      return;
    }
    const target = itemOf(call);
    const series = target === undefined ? undefined : seriesKeyOf(target.key);
    const explained =
      target !== undefined &&
      (status === 404 || status === 410) &&
      (touches(world.removed, target.key) ||
        (series !== undefined && world.reshaped.has(series)) ||
        // An occurrence's delete may follow its series' (the drain does
        // not order the two): the series took it.
        (call.method === 'DELETE' && series !== undefined && world.deletedSeries.has(series)));
    if (!explained) {
      world.violations.push(
        `${call.method} ${new URL(call.url).pathname} was refused with ${status}, but nothing ` +
          `removed ${target?.key ?? 'the item'} from Google: an op went before what it depends on`,
      );
    }
  };
  return world;
};

/** A write of ours landed with its answer lost: Google has changed under the client. */
const lostLanded = (world: World, call: FakeCall) => {
  const target = itemOf(call);
  if (target === undefined) {
    return;
  }
  const deletes = call.method === 'DELETE';
  const keys = [target.key];
  if (deletes || call.url.includes('/move')) {
    keys.push(...world.children.map(taskKey));
    for (const key of keys) {
      world.removed.add(key);
      if (deletes) {
        world.vanished.add(key);
      }
    }
  }
  for (const key of keys) {
    world.disturbed.add(key);
  }
  // A PATCH of a series: see World.reshaped.
  if (call.method === 'PATCH' && target.key.startsWith('event:')) {
    world.reshaped.add(target.key);
  }
};

const setIntent = (
  world: World,
  key: string,
  change: Partial<Omit<Intent & { kind: 'set' }, 'kind'>>,
) => {
  // Gone from Google behind the user's back: no later edit brings it back.
  if (touches(world.vanished, key)) {
    return;
  }
  const before = world.intents.get(key);
  const base = before?.kind === 'set' ? before : { container: undefined, fields: {} };
  world.intents.set(key, {
    container: change.container ?? base.container,
    fields: { ...base.fields, ...change.fields },
    kind: 'set',
  });
};

/** Another device touched the item: the user's last word on it no longer decides. */
const disturb = (world: World, key: string, removed: boolean) => {
  world.disturbed.add(key);
  world.intents.delete(key);
  if (removed) {
    world.removed.add(key);
    world.vanished.add(key);
  }
};

/** The user's last word on a series and on each of its occurrences no longer decides. */
const forgetSeries = (world: World, masterId: string) => {
  world.intents.delete(eventKey(masterId));
  for (const key of world.intents.keys()) {
    if (seriesKeyOf(key) === eventKey(masterId)) {
      world.intents.delete(key);
    }
  }
};

/** Another device touched a series: Google carries that onto its occurrences, or takes them. */
const disturbSeries = (world: World, masterId: string, removed: boolean) => {
  disturb(world, eventKey(masterId), removed);
  forgetSeries(world, masterId);
};

/**
 * The user acts on a series again whose delete still waits (a pull put
 * Google's copy back): deleting it is no longer their last word.
 */
const actsOn = (world: World, masterId: string) => {
  if (world.intents.get(eventKey(masterId))?.kind === 'deleted') {
    world.intents.delete(eventKey(masterId));
  }
};

/** The user's last word no longer names this field (the app derives it now). */
const dropIntentField = (world: World, key: string, field: string) => {
  const intent = world.intents.get(key);
  if (intent?.kind === 'set' && field in intent.fields) {
    const { [field]: _dropped, ...fields } = intent.fields;
    world.intents.set(key, { ...intent, fields });
  }
};

// ---- the checks ----

const readSnapshot = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const events = yield* sql<EventRow>`SELECT calendar_id, description, end_utc, etag, id,
    is_all_day, location, original_start_utc, recurrence, recurring_event_id, start_time_zone,
    start_utc, status, sync_status, title
    FROM events WHERE account_id = ${ACCOUNT_ID} ORDER BY calendar_id, id`;
  const tasks = yield* sql<TaskRow>`SELECT due_date, id, list_id, notes, parent_id, status,
    sync_status, title FROM tasks WHERE account_id = ${ACCOUNT_ID} ORDER BY list_id, id`;
  const copies = yield* sql<Snapshot['copies'][number]>`SELECT id, list_id,
    json_extract(payload, '$.parentId') AS parent FROM task_copies
    WHERE account_id = ${ACCOUNT_ID} ORDER BY list_id, id`;
  const ops = yield* (yield* PendingOpRepo).listAll();
  return { copies, events, ops, tasks } satisfies Snapshot;
}).pipe(Effect.orDie);

/** 1: a pending row is a change still on its way, so a queued op holds it. */
const checkOwned = (world: World, snapshot: Snapshot) => {
  for (const row of snapshot.events) {
    if (
      row.sync_status === 'pending' &&
      !snapshot.ops.some((op) => ownsEvent(op, row.calendar_id, row.id))
    ) {
      world.violations.push(
        `event ${row.id} in ${row.calendar_id} is pending, but no queued op owns it`,
      );
    }
  }
  for (const row of snapshot.tasks) {
    const task = { id: row.id, parent: row.parent_id ?? undefined };
    if (
      row.sync_status === 'pending' &&
      !snapshot.ops.some((op) => ownsTask(op, row.list_id, task))
    ) {
      world.violations.push(
        `task ${row.id} in ${row.list_id} is pending, but no queued op owns it`,
      );
    }
  }
  // Google's copy of a task is kept only while a change of it waits: its
  // own, in whichever list, or a move of the task Google has it under.
  for (const copy of snapshot.copies) {
    if (
      !snapshot.ops.some(
        (op) =>
          !EVENT_KINDS.has(op.kind) &&
          op.kind !== 'calendarColor' &&
          (op.eventId === copy.id || (op.kind === 'moveTask' && op.eventId === copy.parent)),
      )
    ) {
      world.violations.push(
        `Google's copy of task ${copy.id} in ${copy.list_id} is kept, but no queued op holds the task`,
      );
    }
  }
};

/** Google's copy now, null when it has none (deleted, moved away). */
const googleNow = (world: World, container: string, id: string): GcalEvent | GcalTask | null => {
  if ((CALENDARS as ReadonlyArray<string>).includes(container)) {
    const event = world.google.eventOf(container, id);
    return event === undefined || event.status === 'cancelled' ? null : event;
  }
  return world.google.tasksIn(container).find((task) => task.id === id) ?? null;
};

/** Whether a queued op holds the event: its own, or its series' (a series op reaches every occurrence). */
const holdsEvent = (op: PendingOp, eventId: string): boolean =>
  EVENT_KINDS.has(op.kind) && (op.eventId === eventId || isOccurrenceOf(eventId, op.eventId));

/**
 * 3: a synced event row at Google's current etag has Google's content, and
 * whatever Google last told the client about an item no op holds — still
 * Google's copy — is what shows: after a discard, Google's version. An
 * occurrence shows by its exception row or, without one, by its master's
 * rule.
 */
const checkShown = (world: World, snapshot: Snapshot, views: Views) => {
  for (const row of snapshot.events) {
    const theirs = world.google.eventOf(row.calendar_id, row.id);
    if (
      row.sync_status !== 'synced' ||
      row.status === 'cancelled' ||
      theirs === undefined ||
      theirs.status === 'cancelled' ||
      theirs.etag !== row.etag ||
      // An exception shows the text a queued edit of its series carries
      // onto it, as Google will once that lands.
      (row.recurring_event_id !== null &&
        snapshot.ops.some((op) => op.eventId === row.recurring_event_id))
    ) {
      continue;
    }
    const fields = gcalEventFields(row.calendar_id, theirs);
    if (fields !== undefined && !sameFields(eventRowFields(row), fields)) {
      world.violations.push(
        `event ${row.id} in ${row.calendar_id} is synced at Google's etag ${row.etag} but shows ` +
          `${showFields(eventRowFields(row))}; Google has ${showFields(fields)}`,
      );
    }
  }
  for (const [slot, told] of world.told) {
    const [container = '', id = ''] = slot.split('|');
    if (JSON.stringify(googleNow(world, container, id)) !== told.json) {
      continue; // Google moved on since; a pull brings it
    }
    const isEvent = isCalendar(container);
    const parent =
      isEvent || told.item === null || !('parent' in told.item) ? undefined : told.item.parent;
    const held = snapshot.ops.some((op) =>
      isEvent
        ? holdsEvent(op, id)
        : op.eventId === id || (op.kind === 'moveTask' && op.eventId === parent),
    );
    if (held) {
      continue;
    }
    const task = isEvent
      ? undefined
      : snapshot.tasks.find((row) => row.list_id === container && row.id === id);
    const mine = isEvent ? views.client(container).get(id) : task && taskRowFields(task);
    const what = `${isEvent ? 'event' : 'task'} ${id} in ${container}`;
    const key = slot;
    if (told.item === null) {
      if (mine !== undefined) {
        staleOrBroken(
          world,
          key,
          `${what} still shows, though Google said it is gone and no op holds it`,
        );
      }
      continue;
    }
    const theirs = isEvent
      ? gcalEventFields(container, told.item)
      : gcalTaskFields(container, told.item);
    if (theirs === undefined) {
      continue;
    }
    if (mine === undefined) {
      staleOrBroken(
        world,
        key,
        `${what} does not show, though Google has it (and said so) and no op holds it`,
      );
      continue;
    }
    if (!sameFields(mine, theirs)) {
      staleOrBroken(
        world,
        key,
        `${what} shows ${showFields(mine)}, but Google said ${showFields(theirs)} and no op holds it`,
      );
    }
  }
};

/**
 * A difference from Google: the known gap when Google's copy of that slot
 * (or, for an item, of any of its slots; for an occurrence, of its
 * series) is still the one it sent while an op held the row, else a
 * failure.
 */
const staleOrBroken = (world: World, slotOrKey: string, message: string) => {
  const stillThatCopy = (slot: string, json: string) => {
    const [container = '', id = ''] = slot.split('|');
    return shownJson(container, googleNow(world, container, id)) === json;
  };
  const [container = '', id = ''] = slotOrKey.split('|');
  // An exception of a series a list reported gone: see World.unjudged.
  if (world.unjudged.has(`${container}|${masterIdOf(id) ?? ''}`)) {
    return;
  }
  // An occurrence shows what its series' row does: a copy of the master
  // that was skipped is why its occurrences differ too.
  const names = slotOrKey.includes('|')
    ? (slot: string) => slot === slotOrKey || slot === `${container}|${masterIdOf(id) ?? ''}`
    : (slot: string) => keyOfSlot(slot) === slotOrKey || keyOfSlot(slot) === seriesKeyOf(slotOrKey);
  const known = [...world.heldTold].some(
    ([slot, json]) => names(slot) && stillThatCopy(slot, json),
  );
  if (known) {
    world.knownGaps.push(`#${world.step} ${message}`);
  } else {
    world.violations.push(message);
  }
};

/** How heldItems names a series whose move is queued: its exceptions' rows move with it. */
const movingKey = (masterId: string): string => `moving:${masterId}`;

/** Whether the held items (heldItems) hold this one's row. */
const isHeld = (held: ReadonlySet<string>, key: string): boolean => {
  const masterId = key.startsWith('event:') ? masterIdOf(key.slice('event:'.length)) : undefined;
  return held.has(key) || (masterId !== undefined && held.has(movingKey(masterId)));
};

/**
 * The items queued ops hold: their own, the subtasks a task move carries
 * and the exceptions a series' move carries.
 */
const heldItems = (snapshot: Snapshot): Set<string> => {
  const held = new Set<string>();
  for (const op of snapshot.ops) {
    if (EVENT_KINDS.has(op.kind)) {
      held.add(eventKey(op.eventId));
      if (op.kind === 'move') {
        held.add(movingKey(op.eventId));
      }
      continue;
    }
    held.add(taskKey(op.eventId));
    if (op.kind === 'moveTask') {
      for (const row of snapshot.tasks) {
        if (row.parent_id === op.eventId) {
          held.add(taskKey(row.id));
        }
      }
    }
  }
  return held;
};

/** Which copies Google only showed this step reached a row an op held (see World.heldTold). */
const noteHeldCopies = (world: World, snapshot: Snapshot) => {
  const held = heldItems(snapshot);
  for (const [slot, { applied, json, shownOnly }] of world.heard) {
    const key = keyOfSlot(slot);
    if (shownOnly && (isHeld(world.held, key) || isHeld(held, key))) {
      world.heldTold.set(slot, json);
    } else if (applied) {
      world.heldTold.delete(slot);
    }
  }
  world.heard.clear();
  world.held = held;
};

/** 4 (parks): a conflict is parked only on an item someone else changed. */
const checkParks = (world: World, snapshot: Snapshot) => {
  for (const op of snapshot.ops) {
    const key = EVENT_KINDS.has(op.kind) ? eventKey(op.eventId) : taskKey(op.eventId);
    // See World.retagged.
    const series = seriesKeyOf(key);
    if (op.kind === 'delete' && series !== undefined && world.retagged.has(series)) {
      continue;
    }
    if (op.conflictAt !== undefined && !touches(world.disturbed, key)) {
      world.violations.push(`${describeOp(op)} parked a conflict, but nobody else changed ${key}`);
    }
  }
};

/** The sequence is judged by what is recorded of Google only (see FakeGoogle.unverified). */
const checkRecorded = (world: World) => {
  for (const request of world.google.unverified.splice(0)) {
    world.violations.push(
      `the sequence left what is recorded of Google: ${request} (a step to leave out, not a bug)`,
    );
  }
};

const checkStep = (world: World, snapshot: Snapshot) => {
  checkOwned(world, snapshot);
  checkShown(world, snapshot, viewsOf(world.google, snapshot.events));
  checkParks(world, snapshot);
  checkRecorded(world);
};

/** 2: drained and pulled, the client shows what Google has, each series' occurrences included. */
const checkConverged = (world: World, snapshot: Snapshot, views: Views) => {
  for (const op of snapshot.ops) {
    world.violations.push(
      `never drained: ${describeOp(op)}${op.lastError ? ` — ${op.lastError}` : ''}`,
    );
  }
  const compare = (
    what: string,
    mine: ReadonlyMap<string, Fields>,
    theirs: ReadonlyMap<string, Fields>,
  ) => {
    const keyOf = (id: string) => `${what}|${id}`;
    for (const [id, fields] of theirs) {
      const shown = mine.get(id);
      if (shown === undefined) {
        staleOrBroken(
          world,
          keyOf(id),
          `${what}: Google has ${id} (${showFields(fields)}), the client does not`,
        );
      } else if (!sameFields(shown, fields)) {
        staleOrBroken(
          world,
          keyOf(id),
          `${what}: ${id} shows ${showFields(shown)}, Google has ${showFields(fields)}`,
        );
      }
    }
    for (const [id, fields] of mine) {
      if (!theirs.has(id)) {
        staleOrBroken(
          world,
          keyOf(id),
          `${what}: the client shows ${id} (${showFields(fields)}), Google does not`,
        );
      }
    }
  };
  for (const calendarId of CALENDARS) {
    compare(calendarId, views.client(calendarId), views.google(calendarId));
  }
  for (const listId of LISTS) {
    const theirs = new Map<string, Fields>();
    for (const task of world.google.tasksIn(listId)) {
      const fields = gcalTaskFields(listId, task);
      if (fields !== undefined) {
        theirs.set(task.id, fields);
      }
    }
    const mine = new Map(
      snapshot.tasks
        .filter((row) => row.list_id === listId)
        .map((row) => [row.id, taskRowFields(row)] as const),
    );
    compare(listId, mine, theirs);
  }
  for (const row of [...snapshot.events, ...snapshot.tasks]) {
    if (row.sync_status !== 'synced') {
      world.violations.push(`${row.id} is still ${row.sync_status} with the queue empty`);
    }
  }
};

/**
 * Whether the series this one was split from, or that one's own source,
 * may no longer end where the split started: another device touched it,
 * or its cut may have been undone (World.uncut).
 */
const sourceUnsettled = (world: World, key: string): boolean => {
  const seen = new Set<string>();
  let id = world.splitSources.get((seriesKeyOf(key) ?? key).slice('event:'.length));
  while (id !== undefined && !seen.has(id)) {
    if (world.disturbed.has(eventKey(id)) || world.uncut.has(id)) {
      return true;
    }
    seen.add(id);
    id = world.splitSources.get(id);
  }
  return false;
};

/**
 * 2 (intent): what the user did last to an item nobody else touched is
 * what Google has (but see World.heldTold). An occurrence is there when
 * Google draws it, by an exception or by the rule.
 */
const checkIntents = (world: World, views: Views) => {
  for (const [key, intent] of world.intents) {
    const [kind = '', id = ''] = key.split(':');
    // A split-off series lands or goes with its source's cut.
    if (kind === 'event' && sourceUnsettled(world, key)) {
      continue;
    }
    const places: ReadonlyArray<{
      readonly container: string;
      readonly fields: Fields | undefined;
    }> =
      kind === 'event'
        ? CALENDARS.flatMap((calendarId) => {
            const fields = views.google(calendarId).get(id);
            return fields === undefined ? [] : [{ container: calendarId, fields }];
          })
        : LISTS.flatMap((listId) =>
            world.google
              .tasksIn(listId)
              .filter((task) => task.id === id)
              .map((task) => ({ container: listId, fields: gcalTaskFields(listId, task) })),
          );
    if (intent.kind === 'deleted') {
      if (places.length > 0) {
        staleOrBroken(
          world,
          key,
          `the user deleted ${key}, Google still has it in ${places[0]!.container}`,
        );
      }
      continue;
    }
    const place = places[0];
    if (place === undefined || places.length > 1) {
      staleOrBroken(world, key, `the user kept ${key}, Google has it ${places.length} times`);
      continue;
    }
    if (intent.container !== undefined && place.container !== intent.container) {
      staleOrBroken(
        world,
        key,
        `the user moved ${key} to ${intent.container}, Google has it in ${place.container}`,
      );
    }
    for (const [field, value] of Object.entries(intent.fields)) {
      if (place.fields?.[field] !== value) {
        staleOrBroken(
          world,
          key,
          `the user set ${key} ${field}=${JSON.stringify(value)}, Google has ` +
            `${JSON.stringify(place.fields?.[field])}`,
        );
      }
    }
  }
};

// ---- the steps ----

type Services = EventMutations | PendingOpRepo | SqlClient | SyncEngine;

interface Action {
  readonly label: string;
  readonly run: Effect.Effect<void, never, Services>;
}

/**
 * Runs a user action, then `onDone` with what it returned; a refusal the
 * app shows the user is no failure, a database error is.
 */
const attemptThen = <A, E extends { readonly _tag: string }>(
  world: World,
  effect: Effect.Effect<A, E, Services>,
  onDone: (value: A) => Effect.Effect<void, never, Services>,
): Effect.Effect<void, never, Services> =>
  Effect.flatMap(Effect.result(effect), (result) => {
    if (Result.isSuccess(result)) {
      return onDone(result.success);
    }
    return Effect.sync(() => {
      const tag = result.failure._tag;
      world.trace.push(`      refused: ${tag}`);
      if (tag === 'SqlError') {
        world.violations.push(`the database refused a user action: ${failureText(result.failure)}`);
      }
    });
  });

const attempt = <A, E extends { readonly _tag: string }>(
  world: World,
  effect: Effect.Effect<A, E, Services>,
  onDone: (value: A) => void,
): Effect.Effect<void, never, Services> =>
  attemptThen(world, effect, (value) => Effect.sync(() => onDone(value)));

/**
 * The items whose queued ops a step removed or added: a discard's, a
 * keep-theirs'. A task move carried its subtasks, so undoing it is the
 * user's last word on where they are too.
 */
const forgetChanged = (world: World, before: ReadonlyArray<PendingOp>) =>
  Effect.map(readSnapshot, (after) => {
    const ids = new Set(after.ops.map((op) => op.id));
    const was = new Set(before.map((op) => op.id));
    for (const op of [
      ...before.filter((entry) => !ids.has(entry.id)),
      ...after.ops.filter((entry) => !was.has(entry.id)),
    ]) {
      if (!EVENT_KINDS.has(op.kind)) {
        world.intents.delete(taskKey(op.eventId));
        if (op.kind === 'moveTask') {
          for (const row of after.tasks) {
            if (row.parent_id === op.eventId) {
              world.intents.delete(taskKey(row.id));
            }
          }
        }
        continue;
      }
      // A series' change undone takes back what it did to its occurrences
      // (text it carried, exceptions it dropped), and the series a
      // this-and-following edit split off goes or stays with its cut.
      forgetSeries(world, op.eventId);
      world.uncut.add(op.eventId);
    }
  });

const isTemp = (id: string): boolean => id.startsWith('local-');

/** One occurrence of a series, as updateRecurring and deleteRecurring name it. */
const occurrenceAt = (entry: ClientSeries, originalStartUtc: number) => ({
  accountId: ACCOUNT_ID,
  calendarId: entry.master.calendar_id,
  masterId: entry.master.id,
  originalStartUtc,
});

/** The occurrences after a series' first: at the first, "this and following" is an edit of all events. */
const afterFirst = (entry: ClientSeries): ReadonlyArray<Occurrence> =>
  entry.occurrences.filter((occurrence) => occurrence.slot > entry.master.start_utc);

/** An event time two hours on, as a PATCH sends it. */
const twoHoursLater = (time: GcalEvent['start']) => ({
  dateTime: iso(Date.parse(time?.dateTime ?? '') + 2 * HOUR),
});

/** The rules a step gives a series; `lines: null` is "does not repeat". */
const RULES: ReadonlyArray<{
  readonly label: string;
  readonly lines: ReadonlyArray<string> | null;
}> = [
  { label: 'daily, eight times', lines: ['RRULE:FREQ=DAILY;COUNT=8'] },
  { label: 'every other day, four times', lines: ['RRULE:FREQ=DAILY;INTERVAL=2;COUNT=4'] },
  { label: 'does not repeat', lines: null },
];

/** Google's copy of a series wherever it is, as the expansion reads it, with its exceptions. */
const googleSeries = (world: World, masterId: string) =>
  CALENDARS.flatMap((calendarId) => {
    const event = world.google.eventOf(calendarId, masterId);
    const record =
      event === undefined || event.status === 'cancelled'
        ? null
        : mapGcalEvent(event, {
            accountId: ACCOUNT_ID,
            calendarId,
            defaultTimeZone: 'UTC',
            syncedAt: 0,
          });
    return record === null
      ? []
      : [
          {
            exceptions: world.google.exceptionsOf(calendarId, masterId),
            master: recurrenceMasterOf(record),
            startUtc: record.startUtc,
          },
        ];
  });

/**
 * Whether the rule would draw a slot again at which Google's own rule
 * dropped an exception: Google then shows a plain occurrence there, and
 * what its list reports for it is not recorded.
 */
const redrawsDropped = (
  world: World,
  master: EventRow,
  lines: ReadonlyArray<string> | null,
): boolean =>
  lines !== null &&
  googleSeries(world, master.id).some((theirs) =>
    theirs.exceptions.some((exception) => {
      const slot = slotOfId(exception.id);
      return (
        slot !== undefined &&
        exception.status === 'cancelled' &&
        !drawsAt(theirs.master, slot) &&
        drawsAt(ruleMaster(master, lines), slot)
      );
    }),
  );

/**
 * Whether Google or the client holds an exception of the series, or a
 * queued op would make one: what a series' new times do to its exceptions
 * is not recorded, so such a series is not retimed.
 */
const hasExceptions = (world: World, snapshot: Snapshot, series: ClientSeries): boolean =>
  series.overrides.length > 0 ||
  snapshot.ops.some((op) => isOccurrenceOf(op.eventId, series.master.id)) ||
  googleSeries(world, series.master.id).some((theirs) => theirs.exceptions.length > 0);

/**
 * Whether one of the series' exception rows still has the etag it had
 * when the series moved, and Google's copy another: the move's answer
 * names the master's new etag only, and whether Google gives the
 * exceptions new ones (the fake does) is not recorded. Until a pull
 * brings their copies, nothing that sends such an etag is done to the
 * series.
 */
const movedSincePulled = (world: World, series: ClientSeries): boolean =>
  series.overrides.some(
    (row) =>
      row.etag !== null &&
      world.etagsAtMove.get(row.id) === row.etag &&
      world.google.eventOf(row.calendar_id, row.id)?.etag !== row.etag,
  );

/** Whether Google holds the occurrence cancelled: what a PATCH of it does is not recorded. */
const cancelledOnGoogle = (world: World, occurrenceId: string): boolean =>
  CALENDARS.some(
    (calendarId) => world.google.eventOf(calendarId, occurrenceId)?.status === 'cancelled',
  );

/** Whether a queued op of the series carries other times than Google has for it. */
const retiming = (world: World, snapshot: Snapshot, masterId: string): boolean =>
  googleSeries(world, masterId).some((theirs) =>
    snapshot.ops.some(
      (op) =>
        op.eventId === masterId && op.payload != null && op.payload.startUtc !== theirs.startUtc,
    ),
  );

/** The one of two calendars (or lists) that is not `current`. */
const otherOf = <A extends string>(all: ReadonlyArray<A>, current: string): A =>
  all.find((entry) => entry !== current)!;

const userActions = (
  world: World,
  snapshot: Snapshot,
  mutations: EventMutationsShape,
): Record<string, () => Action | undefined> => {
  const { random, step } = world;
  // A series' rows take their own steps: the app refuses a plain edit or
  // delete of one, and a move takes the whole series.
  const singles = snapshot.events.filter(isSingle);
  const allSeries = clientSeries(snapshot.events);
  const movable = [...singles, ...allSeries.map((entry) => entry.master)];
  // What a step does to a series or an occurrence may send an exception's
  // etag (see movedSincePulled).
  const series = allSeries.filter((entry) => !movedSincePulled(world, entry));
  return {
    changeRule: () => {
      const entry = pick(random, series);
      if (!entry) {
        return undefined;
      }
      const { master } = entry;
      const current = recurrenceOf(master).join('\n');
      const rule = pick(
        random,
        RULES.filter(
          (candidate) =>
            (candidate.lines ?? []).join('\n') !== current &&
            !redrawsDropped(world, master, candidate.lines),
        ),
      );
      if (!rule) {
        return undefined;
      }
      return {
        label: `user changes the rule of ${master.id} (${master.calendar_id}): ${rule.label}`,
        run: attempt(
          world,
          mutations.updateRecurring({
            ...occurrenceAt(entry, entry.occurrences[0]?.slot ?? master.start_utc),
            changes: { recurrence: rule.lines },
            scope: 'series',
          }),
          () => {
            setIntent(world, eventKey(master.id), {
              fields: { repeat: (rule.lines ?? []).join('\n') },
            });
            // A rule that draws past a cut again undoes it, and the app
            // then takes the series split off there back.
            world.uncut.add(master.id);
            // An exception the new rule still draws stays as it is, a
            // cancelled one cancelled; the others go with their slots.
            const drawn = (id: string) => {
              const slot = slotOfId(id);
              return (
                rule.lines !== null &&
                slot !== undefined &&
                drawsAt(ruleMaster(master, rule.lines), slot)
              );
            };
            for (const [key, intent] of world.intents) {
              const id = key.slice('event:'.length);
              const stays =
                intent.kind === 'set' ||
                entry.overrides.some((row) => row.id === id && row.status === 'cancelled');
              if (seriesKeyOf(key) === eventKey(master.id) && !(stays && drawn(id))) {
                world.intents.delete(key);
              }
            }
          },
        ),
      };
    },
    completeTask: () => {
      const row = pick(random, snapshot.tasks);
      if (!row) {
        return undefined;
      }
      const status = row.status === 'completed' ? 'needsAction' : 'completed';
      return {
        label: `user marks task ${row.id} (${row.list_id}) ${status}`,
        run: attempt(
          world,
          mutations.completeTask({
            accountId: ACCOUNT_ID,
            status,
            taskId: row.id,
            taskListId: row.list_id,
          }),
          () => {
            if (!isTemp(row.id)) {
              setIntent(world, taskKey(row.id), { fields: { status } });
            }
          },
        ),
      };
    },
    createEvent: () => {
      const calendarId = pick(random, CALENDARS)!;
      const startUtc = START + (8 + (step % 5)) * DAY + 10 * HOUR;
      const title = `New ${step}`;
      return {
        label: `user creates "${title}" in ${calendarId}`,
        run: attempt(
          world,
          mutations.createEvent({
            accountId: ACCOUNT_ID,
            calendarId,
            endUtc: startUtc + HOUR,
            isAllDay: false,
            startTimeZone: 'UTC',
            startUtc,
            title,
          }),
          (record) => {
            world.trace.push(`      → ${record.id}`);
            setIntent(world, eventKey(record.id), {
              container: calendarId,
              fields: { end: String(startUtc + HOUR), start: String(startUtc), title },
            });
          },
        ),
      };
    },
    createSeries: () => {
      // A few at a time: the sequence is about what happens to them.
      if (allSeries.length >= 3) {
        return undefined;
      }
      const calendarId = pick(random, CALENDARS)!;
      const startUtc = START + (3 + (step % 6)) * DAY + 3 * HOUR;
      const title = `Series ${step}`;
      const recurrence = ['RRULE:FREQ=DAILY;COUNT=5'];
      return {
        label: `user creates the series "${title}" in ${calendarId} (daily, five times)`,
        run: attempt(
          world,
          mutations.createEvent({
            accountId: ACCOUNT_ID,
            calendarId,
            endUtc: startUtc + HOUR,
            isAllDay: false,
            recurrence,
            startTimeZone: 'UTC',
            startUtc,
            title,
          }),
          (record) => {
            world.trace.push(`      → ${record.id}`);
            setIntent(world, eventKey(record.id), {
              container: calendarId,
              fields: {
                end: String(startUtc + HOUR),
                repeat: recurrence.join('\n'),
                start: String(startUtc),
                title,
              },
            });
          },
        ),
      };
    },
    createTask: () => {
      const taskListId = pick(random, LISTS)!;
      const title = `Task ${step}`;
      return {
        label: `user creates task "${title}" in ${taskListId}`,
        run: attempt(
          world,
          mutations.createTask({
            accountId: ACCOUNT_ID,
            dueDate: `2026-09-${String(10 + (step % 15)).padStart(2, '0')}`,
            taskListId,
            title,
          }),
          (record) => world.trace.push(`      → ${record.id}`),
        ),
      };
    },
    deleteEvent: () => {
      const row = pick(random, singles);
      if (!row) {
        return undefined;
      }
      return {
        label: `user deletes ${row.id} (${row.calendar_id})`,
        run: attempt(
          world,
          mutations.deleteEvent({
            accountId: ACCOUNT_ID,
            calendarId: row.calendar_id,
            eventId: row.id,
          }),
          () => world.intents.set(eventKey(row.id), { kind: 'deleted' }),
        ),
      };
    },
    deleteOccurrence: () => {
      const entry = pick(
        random,
        series.filter((candidate) => candidate.occurrences.length > 0),
      );
      const occurrence = entry && pick(random, entry.occurrences);
      if (!entry || !occurrence) {
        return undefined;
      }
      return {
        label: `user deletes the occurrence ${occurrence.id} (${entry.master.calendar_id})`,
        run: attempt(
          world,
          mutations.deleteRecurring({ ...occurrenceAt(entry, occurrence.slot), scope: 'instance' }),
          () => {
            actsOn(world, entry.master.id);
            world.intents.set(eventKey(occurrence.id), { kind: 'deleted' });
          },
        ),
      };
    },
    deleteSeries: () => {
      const entry = pick(random, series);
      if (!entry) {
        return undefined;
      }
      const { master } = entry;
      return {
        label: `user deletes the series ${master.id} (${master.calendar_id})`,
        run: attempt(
          world,
          mutations.deleteRecurring({ ...occurrenceAt(entry, master.start_utc), scope: 'series' }),
          () => {
            forgetSeries(world, master.id);
            world.intents.set(eventKey(master.id), { kind: 'deleted' });
          },
        ),
      };
    },
    deleteTask: () => {
      const row = pick(random, snapshot.tasks);
      if (!row) {
        return undefined;
      }
      const subtasks = snapshot.tasks.filter(
        (task) => task.list_id === row.list_id && task.parent_id === row.id,
      );
      return {
        label: `user deletes task ${row.id} (${row.list_id})${subtasks.length > 0 ? ` with ${subtasks.map((task) => task.id).join(', ')}` : ''}`,
        run: attempt(
          world,
          mutations.deleteTask({ accountId: ACCOUNT_ID, taskId: row.id, taskListId: row.list_id }),
          () => {
            for (const task of [row, ...subtasks]) {
              if (!isTemp(task.id)) {
                world.intents.set(taskKey(task.id), { kind: 'deleted' });
              }
            }
          },
        ),
      };
    },
    discard: () => {
      const op = pick(random, snapshot.ops);
      if (!op) {
        return undefined;
      }
      return {
        label: `user discards ${describeOp(op)}`,
        run: Effect.andThen(
          Effect.orDie(mutations.discardPendingOp(op.id)),
          forgetChanged(world, snapshot.ops),
        ),
      };
    },
    editEvent: () => {
      const row = pick(random, singles);
      if (!row) {
        return undefined;
      }
      const field = pick(random, ['title', 'location', 'description', 'time'] as const)!;
      const text = `${field} ${step}`;
      const [changes, fields] =
        field === 'time'
          ? [
              { endUtc: row.end_utc + HOUR, startUtc: row.start_utc + HOUR },
              { end: String(row.end_utc + HOUR), start: String(row.start_utc + HOUR) },
            ]
          : [{ [field]: text }, { [field]: text }];
      return {
        label: `user edits ${row.id} (${row.calendar_id}): ${showFields(fields)}`,
        run: attempt(
          world,
          mutations.updateEvent({
            accountId: ACCOUNT_ID,
            calendarId: row.calendar_id,
            changes,
            eventId: row.id,
          }),
          () => setIntent(world, eventKey(row.id), { fields }),
        ),
      };
    },
    editFollowing: () => {
      const entry = pick(
        random,
        series.filter((candidate) => afterFirst(candidate).length > 0),
      );
      const occurrence = entry && pick(random, afterFirst(entry));
      if (!entry || !occurrence) {
        return undefined;
      }
      const { master } = entry;
      const title = `following ${step}`;
      return {
        label: `user renames ${master.id} (${master.calendar_id}) "${title}" from ${occurrence.id} on`,
        run: attemptThen(
          world,
          mutations.updateRecurring({
            ...occurrenceAt(entry, occurrence.slot),
            changes: { title },
            scope: 'following',
          }),
          () =>
            Effect.map(readSnapshot, (after) => {
              actsOn(world, master.id);
              // From there on the old series draws nothing, whatever it
              // drew or the user had made of an occurrence; the app
              // writes its new end into the rule.
              for (const key of [
                ...entry.occurrences.map((drawn) => eventKey(drawn.id)),
                ...world.intents.keys(),
              ]) {
                const slot = slotOfId(key.slice('event:'.length));
                if (
                  seriesKeyOf(key) === eventKey(master.id) &&
                  slot !== undefined &&
                  slot >= occurrence.slot
                ) {
                  world.intents.set(key, { kind: 'deleted' });
                }
              }
              dropIntentField(world, eventKey(master.id), 'repeat');
              // The new series starts at the occurrence's slot.
              const known = new Set(snapshot.events.map((row) => row.id));
              const split = after.events.find(
                (row) =>
                  !known.has(row.id) &&
                  row.calendar_id === master.calendar_id &&
                  row.recurring_event_id === null,
              );
              if (split) {
                world.trace.push(`      → ${split.id}`);
                world.splitSources.set(split.id, master.id);
                setIntent(world, eventKey(split.id), {
                  container: master.calendar_id,
                  fields: {
                    end: String(occurrence.slot + master.end_utc - master.start_utc),
                    start: String(occurrence.slot),
                    title,
                  },
                });
              }
            }),
        ),
      };
    },
    editOccurrence: () => {
      const entry = pick(
        random,
        series.filter((candidate) => candidate.occurrences.length > 0),
      );
      const occurrence = entry && pick(random, entry.occurrences);
      if (!entry || !occurrence || cancelledOnGoogle(world, occurrence.id)) {
        return undefined;
      }
      const field = pick(random, ['title', 'location', 'description', 'time'] as const)!;
      const text = `${field} ${step}`;
      const [changes, fields] =
        field === 'time'
          ? [
              { endUtc: occurrence.end + HOUR, startUtc: occurrence.start + HOUR },
              { end: String(occurrence.end + HOUR), start: String(occurrence.start + HOUR) },
            ]
          : [{ [field]: text }, { [field]: text }];
      return {
        label: `user edits the occurrence ${occurrence.id} (${entry.master.calendar_id}): ${showFields(fields)}`,
        run: attempt(
          world,
          mutations.updateRecurring({
            ...occurrenceAt(entry, occurrence.slot),
            changes,
            scope: 'instance',
          }),
          () => {
            actsOn(world, entry.master.id);
            setIntent(world, eventKey(occurrence.id), { fields });
          },
        ),
      };
    },
    editSeries: () => {
      const entry = pick(random, series);
      if (!entry) {
        return undefined;
      }
      const { master } = entry;
      const field = pick(
        random,
        hasExceptions(world, snapshot, entry)
          ? (['title', 'location', 'description'] as const)
          : (['title', 'location', 'description', 'time'] as const),
      )!;
      const text = `${field} ${step}`;
      const [changes, fields] =
        field === 'time'
          ? [
              { endUtc: master.end_utc + HOUR, startUtc: master.start_utc + HOUR },
              { end: String(master.end_utc + HOUR), start: String(master.start_utc + HOUR) },
            ]
          : [{ [field]: text }, { [field]: text }];
      return {
        label: `user edits all events of ${master.id} (${master.calendar_id}): ${showFields(fields)}`,
        run: attempt(
          world,
          mutations.updateRecurring({
            ...occurrenceAt(entry, master.start_utc),
            changes,
            scope: 'series',
          }),
          () => {
            setIntent(world, eventKey(master.id), { fields });
            if (field === 'time') {
              // The app moves a rule's end with its occurrences.
              dropIntentField(world, eventKey(master.id), 'repeat');
              return;
            }
            // Google copies a series' changed text onto every exception:
            // the later word on that field, the user's too.
            for (const [key, intent] of world.intents) {
              if (seriesKeyOf(key) === eventKey(master.id) && intent.kind === 'set') {
                world.intents.set(key, { ...intent, fields: { ...intent.fields, ...fields } });
              }
            }
          },
        ),
      };
    },
    editTask: () => {
      const row = pick(random, snapshot.tasks);
      if (!row) {
        return undefined;
      }
      const field = pick(random, ['title', 'notes', 'due'] as const)!;
      const value =
        field === 'due'
          ? `2026-09-${String(10 + (step % 15)).padStart(2, '0')}`
          : `${field} ${step}`;
      return {
        label: `user edits task ${row.id} (${row.list_id}): ${field}=${JSON.stringify(value)}`,
        run: attempt(
          world,
          mutations.updateTask({
            accountId: ACCOUNT_ID,
            changes: field === 'due' ? { dueDate: value } : { [field]: value },
            taskId: row.id,
            taskListId: row.list_id,
          }),
          () => {
            if (!isTemp(row.id)) {
              setIntent(world, taskKey(row.id), { fields: { [field]: value } });
            }
          },
        ),
      };
    },
    moveEvent: () => {
      const row = pick(random, movable);
      if (!row) {
        return undefined;
      }
      const target = otherOf(CALENDARS, row.calendar_id);
      return {
        label: `user moves ${row.id} from ${row.calendar_id} to ${target}`,
        run: attempt(
          world,
          mutations.moveEvent({
            accountId: ACCOUNT_ID,
            calendarId: row.calendar_id,
            eventId: row.id,
            target: { accountId: ACCOUNT_ID, calendarId: target },
          }),
          () => {
            setIntent(world, eventKey(row.id), { container: target });
            for (const override of snapshot.events) {
              if (override.recurring_event_id === row.id && override.etag !== null) {
                world.etagsAtMove.set(override.id, override.etag);
              }
            }
          },
        ),
      };
    },
    moveTask: () => {
      const row = pick(random, snapshot.tasks);
      if (!row) {
        return undefined;
      }
      const target = otherOf(LISTS, row.list_id);
      const retitle = random() < 0.3;
      const title = retitle ? `moved ${step}` : row.title;
      const subtasks = snapshot.tasks.filter(
        (task) => task.list_id === row.list_id && task.parent_id === row.id,
      );
      return {
        label: `user moves task ${row.id} from ${row.list_id} to ${target}${retitle ? `, retitled "${title}"` : ''}`,
        run: attempt(
          world,
          mutations.moveTask({
            accountId: ACCOUNT_ID,
            draft: { dueDate: row.due_date ?? '', notes: row.notes ?? undefined, title },
            target: { accountId: ACCOUNT_ID, taskListId: target },
            taskId: row.id,
            taskListId: row.list_id,
          }),
          () => {
            if (!isTemp(row.id)) {
              setIntent(world, taskKey(row.id), {
                container: target,
                fields: retitle ? { parent: '', title } : { parent: '' },
              });
            }
            for (const task of subtasks) {
              if (!isTemp(task.id)) {
                setIntent(world, taskKey(task.id), { container: target });
              }
            }
          },
        ),
      };
    },
    resolve: () => {
      const op = pick(
        random,
        snapshot.ops.filter((entry) => entry.conflictAt !== undefined),
      );
      if (!op) {
        return undefined;
      }
      const choice = random() < 0.5 ? 'mine' : 'theirs';
      return {
        label: `user keeps ${choice} on ${describeOp(op)}`,
        run: Effect.andThen(
          attempt(world, mutations.resolveConflict({ choice, opId: op.id }), () => undefined),
          choice === 'theirs' ? forgetChanged(world, snapshot.ops) : Effect.void,
        ),
      };
    },
  };
};

const NETWORKS = [
  { lost: 0, name: 'good', refused: 0 },
  { lost: 0.25, name: 'flaky', refused: 0.25 },
  { lost: 0, name: 'down', refused: 1 },
] as const;

/** Moves the client's clock and the fake's together (task `updated` stamps). */
const tick = (world: World, ms: number) =>
  Effect.suspend(() => {
    world.google.now += ms;
    return TestClock.adjust(`${ms} millis`);
  });

const worldActions = (
  world: World,
  snapshot: Snapshot,
  mutations: EventMutationsShape,
  engine: SyncEngineShape,
): Record<string, () => Action | undefined> => {
  const { google, random, step } = world;
  const eventsOnGoogle = () =>
    CALENDARS.flatMap((calendarId) =>
      google.eventsOf(calendarId).map((event) => ({ calendarId, event })),
    );
  // Single events take a raw write; a series and its occurrences take
  // Google's own semantics (the fake's server-side writes).
  const liveEvents = () =>
    eventsOnGoogle().filter(
      ({ event }) => event.recurringEventId === undefined && !event.recurrence?.length,
    );
  const liveSeries = () =>
    eventsOnGoogle().filter(
      ({ event }) => event.recurringEventId === undefined && (event.recurrence?.length ?? 0) > 0,
    );
  /** A series another device may change an occurrence of, and one of the occurrences Google draws. */
  const anOccurrence = () => {
    // An exception made under a retime of ours still queued would meet
    // it on Google: not recorded (see hasExceptions).
    const series = pick(
      random,
      liveSeries().filter(({ event }) => !retiming(world, snapshot, event.id)),
    );
    const instance =
      series &&
      pick(random, google.instancesOf(series.calendarId, series.event.id, WINDOW_FROM, WINDOW_TO));
    return series && instance ? { calendarId: series.calendarId, instance } : undefined;
  };
  const liveTasks = () =>
    LISTS.flatMap((listId) => google.tasksIn(listId).map((task) => ({ listId, task })));
  const drain = (fault: FakeFault | undefined): Action => ({
    label: `drain${fault === undefined ? '' : `, the first write ${fault === 'lost' ? 'lands but its answer is lost' : 'is refused (503)'}`} (network ${world.network.name})`,
    run: Effect.suspend(() => {
      if (fault !== undefined) {
        world.nextWrites.push(fault);
      }
      return Effect.ensuring(
        mutations.processPendingOps(),
        Effect.sync(() => {
          world.nextWrites.length = 0;
        }),
      );
    }),
  });
  return {
    drain: () => drain(undefined),
    drainLost: () => drain('lost'),
    drainRefused: () => drain('refused'),
    expireTokens: () => {
      const calendarId = pick(random, CALENDARS)!;
      return {
        label: `Google expires the sync tokens of ${calendarId} (410: a full pass next)`,
        run: Effect.sync(() => google.expireSyncTokens(calendarId)),
      };
    },
    network: () => {
      const next = pick(random, NETWORKS)!;
      return {
        label: `the network turns ${next.name}`,
        run: Effect.sync(() => {
          world.network = next;
        }),
      };
    },
    otherDeleteEvent: () => {
      const target = pick(random, liveEvents());
      if (!target) {
        return undefined;
      }
      return {
        label: `another device deletes ${target.event.id} (${target.calendarId})`,
        run: Effect.sync(() => {
          google.cancelEvent(target.calendarId, target.event.id);
          disturb(world, eventKey(target.event.id), true);
        }),
      };
    },
    otherDeleteOccurrence: () => {
      const target = anOccurrence();
      // A PATCH of ours that goes without an etag would meet the cancelled
      // occurrence, which is not recorded (see cancelledOnGoogle): one on
      // its way without one, or parked, which keep-mine sends without.
      if (
        !target ||
        snapshot.ops.some(
          (op) =>
            op.eventId === target.instance.id &&
            op.kind === 'update' &&
            (op.baseEtag === undefined || op.conflictAt !== undefined),
        )
      ) {
        return undefined;
      }
      return {
        label: `another device deletes the occurrence ${target.instance.id} (${target.calendarId})`,
        run: Effect.sync(() => {
          google.deleteEventServerSide(target.calendarId, target.instance.id);
          disturb(world, eventKey(target.instance.id), true);
        }),
      };
    },
    otherDeleteSeries: () => {
      const target = pick(random, liveSeries());
      if (!target) {
        return undefined;
      }
      return {
        label: `another device deletes the series ${target.event.id} (${target.calendarId})`,
        run: Effect.sync(() => {
          google.deleteEventServerSide(target.calendarId, target.event.id);
          disturbSeries(world, target.event.id, true);
        }),
      };
    },
    otherDeleteTask: () => {
      const target = pick(random, liveTasks());
      if (!target) {
        return undefined;
      }
      return {
        label: `another device deletes task ${target.task.id} (${target.listId})`,
        run: Effect.sync(() => {
          // Google deletes a parent's subtasks with it.
          for (const task of google.tasksIn(target.listId)) {
            if (task.parent === target.task.id) {
              google.deleteTaskServerSide(target.listId, task.id);
              disturb(world, taskKey(task.id), true);
            }
          }
          google.deleteTaskServerSide(target.listId, target.task.id);
          disturb(world, taskKey(target.task.id), true);
        }),
      };
    },
    otherEditEvent: () => {
      const target = pick(random, liveEvents());
      if (!target) {
        return undefined;
      }
      const summary = `elsewhere ${step}`;
      return {
        label: `another device renames ${target.event.id} (${target.calendarId}) "${summary}"`,
        run: Effect.sync(() => {
          google.putEvent(target.calendarId, { ...target.event, summary });
          disturb(world, eventKey(target.event.id), false);
        }),
      };
    },
    otherEditOccurrence: () => {
      const target = anOccurrence();
      if (!target) {
        return undefined;
      }
      const { instance } = target;
      const moves = random() < 0.4;
      const summary = `elsewhere ${step}`;
      return {
        label: `another device ${moves ? 'moves' : 'renames'} the occurrence ${instance.id} (${target.calendarId})${moves ? ' two hours later' : ` "${summary}"`}`,
        run: Effect.sync(() => {
          google.patchEventServerSide(
            target.calendarId,
            instance.id,
            moves
              ? { end: twoHoursLater(instance.end), start: twoHoursLater(instance.start) }
              : { summary },
          );
          disturb(world, eventKey(instance.id), false);
        }),
      };
    },
    otherEditSeries: () => {
      const target = pick(random, liveSeries());
      if (!target) {
        return undefined;
      }
      const summary = `elsewhere ${step}`;
      return {
        label: `another device renames the series ${target.event.id} (${target.calendarId}) "${summary}"`,
        run: Effect.sync(() => {
          google.patchEventServerSide(target.calendarId, target.event.id, { summary });
          disturbSeries(world, target.event.id, false);
        }),
      };
    },
    otherEditTask: () => {
      const target = pick(random, liveTasks());
      if (!target) {
        return undefined;
      }
      const stored = google.taskOf(target.listId, target.task.id)!;
      const completes = random() < 0.3;
      const changed: GcalTask = completes
        ? { ...stored, status: stored.status === 'completed' ? 'needsAction' : 'completed' }
        : { ...stored, title: `elsewhere ${step}` };
      return {
        label: `another device ${completes ? `marks task ${target.task.id} ${changed.status}` : `renames task ${target.task.id} "${changed.title}"`} (${target.listId})`,
        run: Effect.sync(() => {
          google.putTask(target.listId, changed);
          disturb(world, taskKey(target.task.id), false);
        }),
      };
    },
    pull: () => ({
      label: `sync pass: push, then pull (network ${world.network.name})`,
      run: engine.syncAll(),
    }),
    syncNow: () => ({
      label: `the app comes back: retry now, push, pull (network ${world.network.name})`,
      run: engine.syncNow(),
    }),
    wait: () => {
      const minutes = 1 + Math.floor(random() * 45);
      return {
        label: `${minutes} minutes pass`,
        run: tick(world, minutes * MINUTE),
      };
    },
  };
};

const WEIGHTS: ReadonlyArray<readonly [string, number]> = [
  ['editEvent', 12],
  ['createEvent', 4],
  ['deleteEvent', 5],
  ['moveEvent', 6],
  ['createSeries', 3],
  ['editOccurrence', 8],
  ['deleteOccurrence', 4],
  ['editSeries', 6],
  ['changeRule', 3],
  ['editFollowing', 3],
  ['deleteSeries', 2],
  ['editTask', 8],
  ['completeTask', 4],
  ['createTask', 4],
  ['deleteTask', 4],
  ['moveTask', 5],
  ['discard', 12],
  ['resolve', 5],
  ['drain', 6],
  ['drainLost', 5],
  ['drainRefused', 3],
  ['pull', 7],
  ['syncNow', 2],
  ['wait', 4],
  ['network', 4],
  ['otherEditEvent', 3],
  ['otherDeleteEvent', 1],
  ['otherEditSeries', 2],
  ['otherEditOccurrence', 2],
  ['otherDeleteOccurrence', 1],
  ['otherDeleteSeries', 1],
  ['otherEditTask', 3],
  ['otherDeleteTask', 1],
  ['expireTokens', 1],
];
const TOTAL_WEIGHT = WEIGHTS.reduce((sum, [, weight]) => sum + weight, 0);

const chooseAction = (world: World, actions: Record<string, () => Action | undefined>): Action => {
  let roll = world.random() * TOTAL_WEIGHT;
  const [name] = WEIGHTS.find(([, weight]) => (roll -= weight) < 0) ?? WEIGHTS[0]!;
  return actions[name]?.() ?? actions['drain']!()!;
};

// ---- one sequence ----

const report = (seed: number, world: World, snapshot: Snapshot | undefined): Error =>
  new Error(
    [
      `queue sequence ${seed} broke at step ${world.step}:`,
      ...world.violations.map((violation) => `  ✗ ${violation}`),
      '',
      `replay: QUEUE_SEQUENCE_SEED=${seed} pnpm exec vp test run packages/sync/src/queueSequence.test.ts`,
      'sequence:',
      ...world.trace,
      'requests in that step:',
      ...world.stepLog.map((line) => `  ${line}`),
      'queue after it:',
      ...(snapshot?.ops ?? []).map((op) => `  ${describeOp(op)}`),
      ...(world.knownGaps.length > 0
        ? ['known gap (Google sent a newer copy while an op held the row):', ...world.knownGaps]
        : []),
    ].join('\n'),
  );

const runSequence = (seed: number) => {
  const google = newFake();
  const world = makeWorld(seed, google);
  return Effect.gen(function* () {
    const mutations = yield* EventMutations;
    const engine = yield* SyncEngine;
    yield* TestClock.setTime(START);
    yield* (yield* AccountRepo)
      .upsert(
        new Account({
          contactsEnabled: false,
          createdAt: 1,
          email: EMAIL,
          id: ACCOUNT_ID,
          provider: 'google',
          status: 'ok',
          tasksEnabled: true,
        }),
      )
      .pipe(Effect.orDie);

    /** Lets kicked drains finish, then checks with none running. */
    const settleAndCheck = Effect.gen(function* () {
      for (let round = 0; round < 3; round += 1) {
        yield* Effect.yieldNow;
        yield* mutations.whileQueueHeld(Effect.void);
      }
      const snapshot = yield* mutations.whileQueueHeld(
        Effect.tap(readSnapshot, (current) =>
          Effect.sync(() => {
            noteHeldCopies(world, current);
            checkStep(world, current);
          }),
        ),
      );
      if (world.violations.length > 0) {
        return yield* Effect.die(report(seed, world, snapshot));
      }
      return snapshot;
    });

    world.trace.push('#0 first sync pass');
    yield* engine.syncAll();
    let snapshot = yield* settleAndCheck;

    for (let step = 1; step <= STEPS; step += 1) {
      world.step = step;
      world.stepLog = [];
      yield* tick(world, pick(world.random, [0, 0, 1000, 5000, 20_000])!);
      const action = chooseAction(world, {
        ...userActions(world, snapshot, mutations),
        ...worldActions(world, snapshot, mutations, engine),
      });
      world.trace.push(`#${step} ${action.label}`);
      yield* action.run;
      snapshot = yield* settleAndCheck;
      if (VERBOSE) {
        world.trace.push(...world.stepLog.map((line) => `      ${line}`));
      }
    }

    // The end: the network recovers, every conflict is settled, the
    // queue drains and a pull brings what Google has.
    world.step = STEPS + 1;
    world.network = NETWORKS[0];
    world.trace.push(`#${world.step} the network recovers; drain, settle conflicts, pull`);
    for (let round = 0; round < 8 && snapshot.ops.length > 0; round += 1) {
      world.stepLog = [];
      yield* mutations.retryPendingOps();
      yield* mutations.processPendingOps();
      snapshot = yield* settleAndCheck;
      for (const op of snapshot.ops.filter((entry) => entry.conflictAt !== undefined)) {
        const choice = world.random() < 0.5 ? 'mine' : 'theirs';
        world.trace.push(`    keeps ${choice} on ${describeOp(op)}`);
        yield* attempt(world, mutations.resolveConflict({ choice, opId: op.id }), () => undefined);
        if (choice === 'theirs') {
          yield* forgetChanged(world, snapshot.ops);
        }
      }
      yield* tick(world, 31 * MINUTE);
      yield* engine.syncAll();
      snapshot = yield* settleAndCheck;
      if (VERBOSE) {
        world.trace.push(...world.stepLog.map((line) => `      ${line}`));
      }
    }
    for (let round = 0; round < 2; round += 1) {
      world.stepLog = [];
      yield* tick(world, 2 * MINUTE);
      yield* engine.syncAll();
      snapshot = yield* settleAndCheck;
    }
    const views = viewsOf(world.google, snapshot.events);
    checkConverged(world, snapshot, views);
    checkIntents(world, views);
    if (world.violations.length > 0) {
      return yield* Effect.die(report(seed, world, snapshot));
    }
  }).pipe(noYield, Effect.provide(layerFor(google)), withSeededIds(seed));
};

/**
 * The open gaps the series steps found in the first thousand seeds, as
 * KNOWN_FAILING names them; the skipped tests at the end show each on its
 * own (and three more that only later seeds met).
 */
const GAP = {
  ahead: 'a series change that went back behind an occurrence change made under it',
  dropped: 'the deletes a rule change queued, sent after a delete replaced it',
  givenUp: 'an occurrence changed under a new rule that was given up',
  ownText: "an occurrence's own text under a later edit of its series",
} as const;

/**
 * Seeds that still fail, with the open gap each one meets (the skipped
 * tests at the end show each gap on its own). Found with
 * QUEUE_SEQUENCE_RUNS=1000; a change to the steps, their odds or the
 * requests the app sends reshuffles every sequence, so search again rather
 * than trust these after one.
 */
const KNOWN_FAILING: ReadonlyMap<number, string> = new Map([
  [77, GAP.ahead],
  [215, GAP.givenUp],
  [524, GAP.ownText],
  [565, GAP.ahead],
  [576, GAP.dropped],
]);

describe('pending-op queue: seeded random sequences', () => {
  for (const seed of new Set([...SEEDS, ...KNOWN_FAILING.keys()])) {
    const known = KNOWN_FAILING.get(seed);
    if (known === undefined || RUN_KNOWN) {
      it.effect(`sequence ${seed}`, () => runSequence(seed));
    } else {
      it.effect.skip(`sequence ${seed} (open: ${known})`, () => runSequence(seed));
    }
  }
});

// ---- what the sequences found, each on its own ----

/** Writes fail (503) while true; reads always answer. */
const writesDown = (google: FakeGoogle) => {
  const state = { down: false };
  google.fault = (call) => (state.down && call.method !== 'GET' ? 'refused' : undefined);
  return state;
};

/** The fake with the account signed in and a first pass done, for a scripted run. */
const scripted = <A, E>(
  google: FakeGoogle,
  body: Effect.Effect<A, E, EventMutations | PendingOpRepo | SqlClient | SyncEngine>,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(START);
    yield* (yield* AccountRepo).upsert(
      new Account({
        contactsEnabled: false,
        createdAt: 1,
        email: EMAIL,
        id: ACCOUNT_ID,
        provider: 'google',
        status: 'ok',
        tasksEnabled: true,
      }),
    );
    yield* (yield* SyncEngine).syncAll();
    return yield* body;
  }).pipe(noYield, Effect.provide(layerFor(google)));

const writes = (google: FakeGoogle): Array<string> =>
  google.requests
    .filter((call) => call.method !== 'GET')
    .map((call) => {
      const url = new URL(call.url);
      const destination =
        url.searchParams.get('destination') ?? url.searchParams.get('destinationTasklist');
      return `${call.method} ${url.pathname.replace(/^\/(calendar|tasks)\/v\d\//, '')}${destination ? ` → ${destination}` : ''}`;
    });

describe('pending-op queue: what the sequences found', () => {
  it.effect('discarding a move a subtask came back from puts it back under its parent', () => {
    // Review (Opus, Codex): s1 moved out to list-2 and back, offline, or
    // its parent moved to list-2 and s1 back alone; then the first move
    // discarded. Neither move reached Google, which still has s1 under p
    // in list-1; the move back was re-keyed into a move into its own list
    // (whose answer took the row away), or dropped with the row left out
    // of p, synced — p's delete then took a task shown as one of its own.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const ops = yield* PendingOpRepo;
        const sql = yield* SqlClient;
        const move = (taskId: string, title: string, from: string, to: string) =>
          mutations.moveTask({
            accountId: ACCOUNT_ID,
            draft: { dueDate: due(5).slice(0, 10), title },
            target: { accountId: ACCOUNT_ID, taskListId: to },
            taskId,
            taskListId: from,
          });
        const rows = () =>
          sql<{
            readonly id: string;
            readonly list_id: string;
            readonly parent_id: string | null;
            readonly sync_status: string;
          }>`SELECT id, list_id, parent_id, sync_status FROM tasks
            WHERE id IN ('p', 's1', 's2') ORDER BY id`;
        const asGoogleHasThem = [
          { id: 'p', list_id: 'list-1', parent_id: null, sync_status: 'synced' },
          { id: 's1', list_id: 'list-1', parent_id: 'p', sync_status: 'synced' },
          { id: 's2', list_id: 'list-1', parent_id: 'p', sync_status: 'synced' },
        ];
        network.down = true;
        // The subtask there and back.
        yield* move('s1', 'Pack', 'list-1', 'list-2');
        yield* move('s1', 'Pack', 'list-2', 'list-1');
        yield* mutations.discardPendingOp((yield* ops.listAll())[0]!.id);
        expect(yield* ops.listAll()).toEqual([]);
        expect(yield* rows()).toEqual(asGoogleHasThem);
        // The parent there, the subtask back alone.
        yield* move('p', 'Trip', 'list-1', 'list-2');
        yield* move('s1', 'Pack', 'list-2', 'list-1');
        yield* mutations.discardPendingOp((yield* ops.listAll())[0]!.id);
        expect(yield* ops.listAll()).toEqual([]);
        expect(yield* rows()).toEqual(asGoogleHasThem);
        network.down = false;
        google.requests.length = 0;
        yield* mutations.processPendingOps();
        expect(writes(google)).toEqual([]);
      }),
    );
  });

  it.effect('a move released keeps the etag an edit is checked against', () => {
    // Review (Codex, Opus): with the moved rows' etag cleared, or the If-Match
    // of an edit made while the move waited dropped, a discarded move left
    // the edit unchecked: after another device's change it overwrote that
    // change. Checked, the edit meets Google's newer version and is laid
    // over it: both changes hold. e1: edited after the discard, e2: while
    // the move waited.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const ops = yield* PendingOpRepo;
        network.down = true;
        for (const eventId of ['e1', 'e2']) {
          yield* mutations.moveEvent({
            accountId: ACCOUNT_ID,
            calendarId: 'cal-1',
            eventId,
            target: { accountId: ACCOUNT_ID, calendarId: 'cal-2' },
          });
        }
        yield* mutations.updateEvent({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-2',
          changes: { description: 'Agenda' },
          eventId: 'e2',
        });
        yield* mutations.processPendingOps();
        for (const move of (yield* ops.listAll()).filter((op) => op.kind === 'move')) {
          yield* mutations.discardPendingOp(move.id);
        }
        for (const eventId of ['e1', 'e2']) {
          google.putEvent('cal-1', {
            ...google.eventOf('cal-1', eventId)!,
            summary: 'Renamed elsewhere',
          });
        }
        yield* mutations.updateEvent({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-1',
          changes: { description: 'Agenda' },
          eventId: 'e1',
        });
        network.down = false;
        yield* mutations.retryPendingOps();
        yield* mutations.processPendingOps();
        for (const eventId of ['e1', 'e2']) {
          expect(google.eventOf('cal-1', eventId)).toMatchObject({
            description: 'Agenda',
            summary: 'Renamed elsewhere',
          });
        }
        expect(yield* ops.listAll()).toEqual([]);
      }),
    );
  });

  it.effect('a move landing under a parked conflict leaves the row Google’s version', () => {
    // Sequence 514 (review round 2's fix): another device renamed the event,
    // the user's rename parked, the event was moved and the move landed. Had
    // the row taken the move's etag, discarding the edit left it synced at
    // Google's current etag with the old title.
    const google = newFake();
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        google.putEvent('cal-1', {
          ...google.eventOf('cal-1', 'e1')!,
          summary: 'Renamed elsewhere',
        });
        yield* mutations.updateEvent({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-1',
          changes: { title: 'Renamed here' },
          eventId: 'e1',
        });
        yield* mutations.processPendingOps();
        yield* mutations.moveEvent({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-1',
          eventId: 'e1',
          target: { accountId: ACCOUNT_ID, calendarId: 'cal-2' },
        });
        yield* mutations.processPendingOps();
        expect(google.eventOf('cal-2', 'e1')?.summary).toBe('Renamed elsewhere');
        const [parked] = yield* (yield* PendingOpRepo).listAll();
        expect(parked?.conflictAt).toBeDefined();
        yield* mutations.discardPendingOp(parked!.id);
        const [row] = yield* (yield* SqlClient)<{
          readonly etag: string | null;
          readonly title: string;
        }>`SELECT etag, title FROM events WHERE id = 'e1'`;
        // At Google's etag only with Google's title.
        const theirs = google.eventOf('cal-2', 'e1')!;
        expect(row?.etag === theirs.etag && row?.title !== theirs.summary).toBe(false);
      }),
    );
  });

  it.effect('an edit after a move landed under a waiting edit goes on the new etag', () => {
    // Review (Opus): the move landed while an edit made during the wait
    // still held the row, which kept the etag from before the move; the
    // next edit sent that one, met a 412 and parked a conflict nobody
    // caused.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const ref = { accountId: ACCOUNT_ID, calendarId: 'cal-2', eventId: 'e1' };
        network.down = true;
        yield* mutations.moveEvent({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-1',
          eventId: 'e1',
          target: { accountId: ACCOUNT_ID, calendarId: 'cal-2' },
        });
        yield* mutations.updateEvent({ ...ref, changes: { description: 'Agenda' } });
        // The move lands; the edit meets a 503.
        google.fault = (call) => (call.method === 'PATCH' ? 'refused' : undefined);
        yield* mutations.retryPendingOps();
        yield* mutations.processPendingOps();
        expect(google.eventOf('cal-2', 'e1')).toBeDefined();
        yield* mutations.updateEvent({ ...ref, changes: { location: 'Room 4' } });
        google.fault = undefined;
        yield* mutations.retryPendingOps();
        yield* mutations.processPendingOps();
        expect((yield* (yield* PendingOpRepo).listAll()).map(describeOp)).toEqual([]);
        expect(google.eventOf('cal-2', 'e1')).toMatchObject({
          description: 'Agenda',
          location: 'Room 4',
        });
      }),
    );
  });

  it.effect('a discarded create takes a chain of moves along, and the rows at its end', () => {
    // Review (Codex, Opus): created, refused, moved cal-1 → cal-2 → cal-3,
    // the create discarded: only the first move's destination was cleared,
    // and the event stayed in cal-3, pending with no op, for good.
    const google = newFake({ thirdCalendar: true });
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const ops = yield* PendingOpRepo;
        network.down = true;
        const created = yield* mutations.createEvent({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-1',
          endUtc: START + 9 * DAY + 11 * HOUR,
          isAllDay: false,
          startTimeZone: 'UTC',
          startUtc: START + 9 * DAY + 10 * HOUR,
          title: 'Dentist',
        });
        yield* mutations.processPendingOps();
        for (const [from, to] of [
          ['cal-1', 'cal-2'],
          ['cal-2', 'cal-3'],
        ] as const) {
          yield* mutations.moveEvent({
            accountId: ACCOUNT_ID,
            calendarId: from,
            eventId: created.id,
            target: { accountId: ACCOUNT_ID, calendarId: to },
          });
        }
        const create = (yield* ops.listAll()).find((op) => op.kind === 'create')!;
        yield* mutations.discardPendingOp(create.id);
        expect(yield* ops.listAll()).toEqual([]);
        expect(
          yield* (yield* SqlClient)`SELECT calendar_id FROM events WHERE id = ${created.id}`,
        ).toEqual([]);
      }),
    );
  });

  it.effect("discarding the first of a task's moves there and back sends nothing", () => {
    // Review (Opus): the move back was re-keyed to leave from the list it
    // went to — a move into its own list, whose answer took the row away.
    // It has nothing left to move, as an event's move back does.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const ops = yield* PendingOpRepo;
        const move = (from: string, to: string) =>
          mutations.moveTask({
            accountId: ACCOUNT_ID,
            draft: { dueDate: due(7).slice(0, 10), title: 'Call' },
            target: { accountId: ACCOUNT_ID, taskListId: to },
            taskId: 't2',
            taskListId: from,
          });
        network.down = true;
        yield* move('list-2', 'list-1');
        yield* move('list-1', 'list-2');
        const [first] = yield* ops.listAll();
        yield* mutations.discardPendingOp(first!.id);
        expect(yield* ops.listAll()).toEqual([]);
        network.down = false;
        google.requests.length = 0;
        yield* mutations.processPendingOps();
        expect(writes(google)).toEqual([]);
        const rows = yield* (yield* SqlClient)<{
          readonly list_id: string;
          readonly sync_status: string;
        }>`SELECT list_id, sync_status FROM tasks WHERE id = 't2'`;
        expect(rows).toEqual([{ list_id: 'list-2', sync_status: 'synced' }]);
      }),
    );
  });

  it.effect('a task deleted after moving away and back keeps the moves ahead of its delete', () => {
    // Sequence 920: list-2 → list-1 → list-2 → delete, offline. The delete
    // dropped everything queued for the task in its list, the first move
    // out of it included, so the move back met a 404 — and the delete too.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const move = (from: string, to: string) =>
          mutations.moveTask({
            accountId: ACCOUNT_ID,
            draft: { dueDate: due(7).slice(0, 10), title: 'Call' },
            target: { accountId: ACCOUNT_ID, taskListId: to },
            taskId: 't2',
            taskListId: from,
          });
        network.down = true;
        yield* move('list-2', 'list-1');
        yield* move('list-1', 'list-2');
        yield* mutations.deleteTask({ accountId: ACCOUNT_ID, taskId: 't2', taskListId: 'list-2' });
        network.down = false;
        google.requests.length = 0;
        for (let round = 0; round < 3; round += 1) {
          yield* mutations.retryPendingOps();
          yield* mutations.processPendingOps();
        }
        expect(writes(google)).toEqual([
          'POST lists/list-2/tasks/t2/move → list-1',
          'POST lists/list-1/tasks/t2/move → list-2',
          'DELETE lists/list-2/tasks/t2',
        ]);
        expect(google.taskOf('list-2', 't2')?.deleted).toBe(true);
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      }),
    );
  });

  it.effect("discarding an event's sent create takes what was queued behind it along", () => {
    // Sequence 38: an event created offline (its insert went out and met a
    // 503), edited, deleted; then the create discarded, then the delete.
    // The delete's discard put its snapshot back as a synced event Google
    // never had, and no pull ever took it away.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const engine = yield* SyncEngine;
        const ops = yield* PendingOpRepo;
        network.down = true;
        const created = yield* mutations.createEvent({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-1',
          endUtc: START + 9 * DAY + 11 * HOUR,
          isAllDay: false,
          startTimeZone: 'UTC',
          startUtc: START + 9 * DAY + 10 * HOUR,
          title: 'Dentist',
        });
        yield* mutations.processPendingOps();
        const ref = { accountId: ACCOUNT_ID, calendarId: 'cal-1', eventId: created.id };
        yield* mutations.updateEvent({ ...ref, changes: { title: 'Dentist (moved)' } });
        yield* mutations.deleteEvent(ref);
        // Sequence 231: one moved too, with an edit re-queued behind the move.
        const other = yield* mutations.createEvent({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-1',
          endUtc: START + 10 * DAY + 11 * HOUR,
          isAllDay: false,
          startTimeZone: 'UTC',
          startUtc: START + 10 * DAY + 10 * HOUR,
          title: 'Haircut',
        });
        yield* mutations.processPendingOps();
        const otherRef = { accountId: ACCOUNT_ID, calendarId: 'cal-1', eventId: other.id };
        yield* mutations.updateEvent({ ...otherRef, changes: { location: 'Salon' } });
        yield* mutations.moveEvent({
          ...otherRef,
          target: { accountId: ACCOUNT_ID, calendarId: 'cal-2' },
        });
        const otherCreate = (yield* ops.listAll()).find(
          (op) => op.kind === 'create' && op.eventId === other.id,
        )!;
        yield* mutations.discardPendingOp(otherCreate.id);
        const create = (yield* ops.listAll()).find(
          (op) => op.kind === 'create' && op.eventId === created.id,
        )!;
        expect(create.dispatchedAt).toBeDefined();
        yield* mutations.discardPendingOp(create.id);
        expect(yield* ops.listAll()).toEqual([]);
        network.down = false;
        yield* TestClock.adjust('1 minute');
        yield* engine.syncNow();
        expect(
          yield* (yield* SqlClient)`SELECT id FROM events WHERE id IN (${created.id}, ${other.id})`,
        ).toEqual([]);
        expect(google.eventOf('cal-1', created.id)).toBeUndefined();
        expect(google.requests.some((call) => call.url.includes(other.id))).toBe(false);
      }),
    );
  });

  it.effect("discarding a task's sent create takes what was queued behind it along", () => {
    // Sequence 171: the edit queued behind a create that went out names the
    // task's temp id and waits for Google's; with the create discarded it
    // waited for good.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const ops = yield* PendingOpRepo;
        network.down = true;
        const created = yield* mutations.createTask({
          accountId: ACCOUNT_ID,
          dueDate: '2026-09-12',
          taskListId: 'list-1',
          title: 'Groceries',
        });
        yield* mutations.processPendingOps();
        yield* mutations.updateTask({
          accountId: ACCOUNT_ID,
          changes: { title: 'Groceries and wine' },
          taskId: created.id,
          taskListId: 'list-1',
        });
        const create = (yield* ops.listAll()).find((op) => op.kind === 'createTask')!;
        expect(create.dispatchedAt).toBeDefined();
        yield* mutations.discardPendingOp(create.id);
        expect(yield* ops.listAll()).toEqual([]);
      }),
    );
  });

  it.effect("a parent's delete waits for the move that takes a subtask out of it", () => {
    // Sequences 117 and 140: the subtask's move waited out a 503 while the
    // parent's delete, queued after it, went: Google deleted the subtask
    // with its parent, and the move met a 404.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        network.down = true;
        yield* mutations.moveTask({
          accountId: ACCOUNT_ID,
          draft: { dueDate: due(5).slice(0, 10), title: 'Book' },
          target: { accountId: ACCOUNT_ID, taskListId: 'list-2' },
          taskId: 's2',
          taskListId: 'list-1',
        });
        yield* mutations.deleteTask({ accountId: ACCOUNT_ID, taskId: 'p', taskListId: 'list-1' });
        network.down = false;
        // The move meets one more 503; the deletes are due.
        let refuseMove = true;
        google.fault = (call) => {
          if (refuseMove && call.url.includes('/move')) {
            refuseMove = false;
            return 'refused';
          }
          return undefined;
        };
        yield* mutations.retryPendingOps();
        yield* mutations.processPendingOps();
        yield* mutations.retryPendingOps();
        yield* mutations.processPendingOps();
        yield* mutations.retryPendingOps();
        yield* mutations.processPendingOps();
        expect(google.taskOf('list-2', 's2')).toMatchObject({ title: 'Book' });
        expect(google.taskOf('list-2', 's2')?.deleted).toBeUndefined();
        expect(google.taskOf('list-1', 'p')?.deleted).toBe(true);
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      }),
    );
  });

  it.effect('discarding a task moved back leaves the move it undid in place', () => {
    // Sequence 103: there and back while offline, then the way back
    // discarded. Its release re-keyed everything of the task in the list it
    // had moved to — the first move included, which became a move from
    // list-1 into list-1 and met a 404: the task stayed where it started.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const move = (from: string, to: string) =>
          mutations.moveTask({
            accountId: ACCOUNT_ID,
            draft: { dueDate: due(7).slice(0, 10), title: 'Call' },
            target: { accountId: ACCOUNT_ID, taskListId: to },
            taskId: 't2',
            taskListId: from,
          });
        network.down = true;
        yield* move('list-2', 'list-1');
        yield* move('list-1', 'list-2');
        const ops = yield* (yield* PendingOpRepo).listAll();
        yield* mutations.discardPendingOp(ops.at(-1)!.id);
        network.down = false;
        google.requests.length = 0;
        yield* mutations.retryPendingOps();
        yield* mutations.processPendingOps();
        expect(writes(google)).toEqual(['POST lists/list-2/tasks/t2/move → list-1']);
        expect(google.taskOf('list-1', 't2')?.title).toBe('Call');
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      }),
    );
  });

  it.effect('a task whose delete waits stays deleted through a pull', () => {
    // Sequence 13, as it was: the delete waited out a 503, a pull put
    // Google's copy back as a row, the user completed that copy, and the
    // delete, still ahead, landed: the completion met a 404. Google's copy
    // of a held task goes beside its row now, so nothing comes back to act
    // on and the delete lands as the user left it.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const engine = yield* SyncEngine;
        const sql = yield* SqlClient;
        const shown = sql<{ readonly id: string }>`
          SELECT id FROM tasks WHERE id IN ('t1', 'p', 's1', 's2')`;
        network.down = true;
        yield* mutations.deleteTask({ accountId: ACCOUNT_ID, taskId: 't1', taskListId: 'list-1' });
        // A parent goes with its subtasks.
        yield* mutations.deleteTask({ accountId: ACCOUNT_ID, taskId: 'p', taskListId: 'list-1' });
        google.now += MINUTE;
        yield* TestClock.adjust('1 minute');
        yield* engine.syncAll();
        expect(yield* shown).toEqual([]);
        // Nothing is there to move, either.
        const moved = yield* Effect.result(
          mutations.moveTask({
            accountId: ACCOUNT_ID,
            draft: { dueDate: due(5).slice(0, 10), title: 'Trip' },
            target: { accountId: ACCOUNT_ID, taskListId: 'list-2' },
            taskId: 'p',
            taskListId: 'list-1',
          }),
        );
        expect(Result.isFailure(moved)).toBe(true);
        network.down = false;
        for (let round = 0; round < 3; round += 1) {
          yield* mutations.retryPendingOps();
          yield* mutations.processPendingOps();
        }
        expect(google.taskOf('list-1', 't1')?.deleted).toBe(true);
        expect(google.taskOf('list-1', 'p')?.deleted).toBe(true);
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
        expect(yield* shown).toEqual([]);
        // Google's copies went with the deletes that held them.
        expect(yield* sql`SELECT id FROM task_copies`).toEqual([]);
      }),
    );
  });

  it.effect('a pull leaves out an event a queued move takes out of the calendar', () => {
    // Sequences 32, 97, 176 and 182: the pull wrote Google's copy of the
    // moving event back into its source, so it showed in both calendars;
    // the user deleted or edited the copy, and that op met a 404 there
    // once the move landed — or, discarded, left a pending row no op owned.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const engine = yield* SyncEngine;
        // An edit that lands: Google's copy is newer than the last pull's.
        yield* mutations.updateEvent({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-1',
          changes: { title: 'Lunch with Ana' },
          eventId: 'e2',
        });
        yield* mutations.processPendingOps();
        network.down = true;
        yield* mutations.moveEvent({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-1',
          eventId: 'e2',
          target: { accountId: ACCOUNT_ID, calendarId: 'cal-2' },
        });
        yield* TestClock.adjust('1 minute');
        yield* engine.syncAll();
        const sql = yield* SqlClient;
        const where = () =>
          Effect.map(
            sql<{ readonly calendar_id: string }>`SELECT calendar_id FROM events WHERE id = 'e2'`,
            (rows) => rows.map((row) => row.calendar_id),
          );
        expect(yield* where()).toEqual(['cal-2']);
        network.down = false;
        yield* TestClock.adjust('1 minute');
        yield* engine.syncNow();
        expect(yield* where()).toEqual(['cal-2']);
        expect(google.eventOf('cal-2', 'e2')?.summary).toBe('Lunch with Ana');
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      }),
    );
  });

  it.effect("an edit or a delete made while a move waits follows the move's new etag", () => {
    // Sequences 149 and 100: the moved row kept the source's etag, the
    // edit (or delete) made after the move sent it as its If-Match, and
    // once the move landed — with a new etag — it met a 412 and parked a
    // conflict nobody caused.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        network.down = true;
        for (const eventId of ['e1', 'e2']) {
          yield* mutations.moveEvent({
            accountId: ACCOUNT_ID,
            calendarId: 'cal-1',
            eventId,
            target: { accountId: ACCOUNT_ID, calendarId: 'cal-2' },
          });
        }
        yield* mutations.updateEvent({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-2',
          changes: { title: 'Moved standup' },
          eventId: 'e1',
        });
        yield* mutations.deleteEvent({ accountId: ACCOUNT_ID, calendarId: 'cal-2', eventId: 'e2' });
        yield* mutations.processPendingOps();
        network.down = false;
        yield* mutations.retryPendingOps();
        yield* mutations.processPendingOps();
        yield* mutations.processPendingOps();
        expect((yield* (yield* PendingOpRepo).listAll()).map(describeOp)).toEqual([]);
        expect(google.eventOf('cal-2', 'e1')?.summary).toBe('Moved standup');
        expect(google.eventOf('cal-2', 'e2')?.status).toBe('cancelled');
      }),
    );
  });

  it.effect(
    'a move made while an earlier move out of its calendar waits leaves that move first',
    () => {
      // Sequence 35: there and back and there again while offline. The
      // third move re-keyed the first as its follower — a move from cal-2 to
      // cal-2 behind it — so the move back went first, met a 404 and counted
      // as landed, and the stray move gave the event a new etag.
      const google = newFake();
      const network = writesDown(google);
      return scripted(
        google,
        Effect.gen(function* () {
          const mutations = yield* EventMutations;
          const move = (from: string, to: string) =>
            mutations.moveEvent({
              accountId: ACCOUNT_ID,
              calendarId: from,
              eventId: 'e1',
              target: { accountId: ACCOUNT_ID, calendarId: to },
            });
          network.down = true;
          yield* move('cal-1', 'cal-2');
          yield* move('cal-2', 'cal-1');
          yield* move('cal-1', 'cal-2');
          yield* mutations.processPendingOps();
          network.down = false;
          google.requests.length = 0;
          yield* mutations.retryPendingOps();
          yield* mutations.processPendingOps();
          yield* mutations.processPendingOps();
          expect(writes(google)).toEqual([
            'POST calendars/cal-1/events/e1/move → cal-2',
            'POST calendars/cal-2/events/e1/move → cal-1',
            'POST calendars/cal-1/events/e1/move → cal-2',
          ]);
          expect(google.eventOf('cal-2', 'e1')?.status).toBe('confirmed');
          expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
        }),
      );
    },
  );
});

describe('pending-op queue: a held task and Google’s copy of it', () => {
  it.effect('a pull shows Google’s newer copy under a queued edit, and a discard leaves it', () => {
    // The gap the event rows still have (below), closed for tasks: the
    // pull used to skip a row a queued op held, its watermark moved past
    // Google's copy, and a discard put back the older snapshot.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const engine = yield* SyncEngine;
        const sql = yield* SqlClient;
        const row = Effect.map(
          sql<{
            readonly notes: string | null;
            readonly sync_status: string;
            readonly title: string;
          }>`SELECT notes, sync_status, title FROM tasks WHERE id = 't1'`,
          (rows) => rows[0],
        );
        network.down = true;
        yield* mutations.updateTask({
          accountId: ACCOUNT_ID,
          changes: { title: 'Call the bank' },
          taskId: 't1',
          taskListId: 'list-1',
        });
        google.now += MINUTE;
        google.putTask('list-1', { ...google.taskOf('list-1', 't1')!, notes: 'Before noon' });
        google.now += MINUTE;
        yield* TestClock.adjust('2 minutes');
        yield* engine.syncAll();
        // Both hold: the rename made here, the notes made elsewhere.
        expect(yield* row).toEqual({
          notes: 'Before noon',
          sync_status: 'pending',
          title: 'Call the bank',
        });
        const [op] = yield* (yield* PendingOpRepo).listAll();
        yield* mutations.discardPendingOp(op!.id);
        const theirs = google.taskOf('list-1', 't1')!;
        expect(yield* row).toEqual({
          notes: 'Before noon',
          sync_status: 'synced',
          title: theirs.title,
        });
        expect(yield* sql`SELECT id FROM task_copies`).toEqual([]);
      }),
    );
  });

  it.effect('an edit sent after a pull keeps what another device changed', () => {
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const engine = yield* SyncEngine;
        network.down = true;
        yield* mutations.updateTask({
          accountId: ACCOUNT_ID,
          changes: { title: 'Call the bank' },
          taskId: 't1',
          taskListId: 'list-1',
        });
        google.now += MINUTE;
        google.putTask('list-1', { ...google.taskOf('list-1', 't1')!, notes: 'Before noon' });
        google.now += MINUTE;
        yield* TestClock.adjust('2 minutes');
        yield* engine.syncAll();
        network.down = false;
        yield* mutations.retryPendingOps();
        yield* mutations.processPendingOps();
        expect(google.taskOf('list-1', 't1')).toMatchObject({
          notes: 'Before noon',
          title: 'Call the bank',
        });
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
        const sql = yield* SqlClient;
        expect(yield* sql`SELECT notes, sync_status, title FROM tasks WHERE id = 't1'`).toEqual([
          { notes: 'Before noon', sync_status: 'synced', title: 'Call the bank' },
        ]);
      }),
    );
  });
});

/** A move of a fixture task as its form sends it: nothing but the list changes. */
const moveOf = (
  mutations: EventMutationsShape,
  task: { readonly day: number; readonly id: string; readonly title: string },
  from: string,
  to: string,
) =>
  mutations.moveTask({
    accountId: ACCOUNT_ID,
    draft: { dueDate: due(task.day).slice(0, 10), title: task.title },
    target: { accountId: ACCOUNT_ID, taskListId: to },
    taskId: task.id,
    taskListId: from,
  });
const drainAll = (mutations: EventMutationsShape) =>
  Effect.gen(function* () {
    for (let round = 0; round < 3; round += 1) {
      yield* mutations.retryPendingOps();
      yield* mutations.processPendingOps();
    }
  });
/** The first move lands with its answer lost; writes are refused from then on, until `up`. */
const losingFirstMove = (google: FakeGoogle) => {
  const state = { down: false, lost: false };
  google.fault = (call) => {
    if (call.method === 'GET') {
      return undefined;
    }
    if (!state.lost && call.url.includes('/move')) {
      state.lost = true;
      state.down = true;
      return 'lost';
    }
    return state.down ? 'refused' : undefined;
  };
  return state;
};

describe('pending-op queue: task moves and the subtasks they carry', () => {
  const TRIP = { day: 5, id: 'p', title: 'Trip' };
  const PACK = { day: 5, id: 's1', title: 'Pack' };
  /** Where the rows of the trip and its subtasks are, as `list/id` (`/parent`). */
  const placed = Effect.gen(function* () {
    const rows = yield* (yield* SqlClient)<{
      readonly id: string;
      readonly list_id: string;
      readonly parent_id: string | null;
    }>`SELECT id, list_id, parent_id FROM tasks WHERE id IN ('p', 's1', 's2') ORDER BY id, list_id`;
    return rows.map(
      (row) => `${row.list_id}/${row.id}${row.parent_id === null ? '' : `/${row.parent_id}`}`,
    );
  });
  const copies = Effect.flatMap(SqlClient, (sql) => sql`SELECT id FROM task_copies`);
  it.effect('a pull shows a carried subtask where its parent’s last queued move puts it', () => {
    // Sequence 38: the parent moved, moved back and moved again; a pull
    // then rebuilt a subtask's row from the first of the two queued moves
    // alone and left a second row of it in the list it had left.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        yield* moveOf(mutations, TRIP, 'list-1', 'list-2');
        yield* mutations.processPendingOps();
        expect(yield* placed).toEqual(['list-2/p', 'list-2/s1/p', 'list-2/s2/p']);
        network.down = true;
        yield* moveOf(mutations, TRIP, 'list-2', 'list-1');
        yield* moveOf(mutations, TRIP, 'list-1', 'list-2');
        google.now += MINUTE;
        yield* TestClock.adjust('1 minute');
        yield* (yield* SyncEngine).syncAll();
        expect(yield* placed).toEqual(['list-2/p', 'list-2/s1/p', 'list-2/s2/p']);
      }),
    );
  });

  it.effect(
    'a subtask taken out of its parent elsewhere does not stay behind in the destination',
    () => {
      // The parent's move waits; another device drags a subtask out of it in
      // the source. Google then leaves that task where it is. The move's
      // landing put its row back in the source and left the one it had
      // taken to the destination: pending under the parent, with no op.
      const google = newFake();
      const network = writesDown(google);
      return scripted(
        google,
        Effect.gen(function* () {
          const mutations = yield* EventMutations;
          network.down = true;
          yield* moveOf(mutations, TRIP, 'list-1', 'list-2');
          expect(yield* placed).toEqual(['list-2/p', 'list-2/s1/p', 'list-2/s2/p']);
          google.moveTaskServerSide('list-1', 's2', {});
          google.now += MINUTE;
          yield* TestClock.adjust('1 minute');
          yield* (yield* SyncEngine).syncAll();
          network.down = false;
          yield* drainAll(mutations);
          expect((yield* (yield* PendingOpRepo).listAll()).map(describeOp)).toEqual([]);
          expect(yield* placed).toEqual(['list-2/p', 'list-2/s1/p', 'list-1/s2']);
        }),
      );
    },
  );

  it.effect('a subtask moved out and back stays out of its parent when the order is read', () => {
    // Sequence 1813: the subtask moved to another list and back while
    // offline, which takes it out of its parent. A pass that read the
    // list's order wrote Google's on the rows, where the subtask is still
    // under that parent, and the parent's next move took it along here:
    // its edits then went to a list Google never had it in.
    const google = newFake();
    const network = writesDown(google);
    const BOOK = { day: 5, id: 's2', title: 'Book' };
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        network.down = true;
        yield* moveOf(mutations, BOOK, 'list-1', 'list-2');
        yield* moveOf(mutations, BOOK, 'list-2', 'list-1');
        expect(yield* placed).toEqual(['list-1/p', 'list-1/s1/p', 'list-1/s2']);
        // Another device changes the list, so its order is read again.
        google.insertTaskServerSide('list-1', {
          id: 'other',
          status: 'needsAction',
          title: 'Other',
        });
        google.now += MINUTE;
        yield* TestClock.adjust('1 minute');
        yield* (yield* SyncEngine).syncAll();
        expect(yield* placed).toEqual(['list-1/p', 'list-1/s1/p', 'list-1/s2']);
        yield* moveOf(mutations, TRIP, 'list-1', 'list-2');
        expect(yield* placed).toEqual(['list-2/p', 'list-2/s1/p', 'list-1/s2']);
      }),
    );
  });

  it.effect(
    'a subtask’s own move undone while its parent’s move waits goes with its parent',
    () => {
      // Sequence 2710: the subtask went back to the source while its parent's
      // row was already in the destination — Google takes it along once the
      // parent's move lands — and its next move met a row of it in each list.
      const google = newFake();
      const network = writesDown(google);
      return scripted(
        google,
        Effect.gen(function* () {
          const mutations = yield* EventMutations;
          network.down = true;
          yield* moveOf(mutations, PACK, 'list-1', 'list-2');
          yield* mutations.processPendingOps();
          yield* moveOf(mutations, TRIP, 'list-1', 'list-2');
          const [own] = yield* (yield* PendingOpRepo).listAll();
          expect(own).toMatchObject({ eventId: 's1', kind: 'moveTask' });
          yield* mutations.discardPendingOp(own!.id);
          expect(yield* placed).toEqual(['list-2/p', 'list-2/s1/p', 'list-2/s2/p']);
          network.down = false;
          yield* drainAll(mutations);
          expect(
            google
              .tasksIn('list-2')
              .map((task) => task.id)
              .sort(),
          ).toEqual(['p', 's1', 's2', 't2']);
          expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
          expect(yield* copies).toEqual([]);
        }),
      );
    },
  );

  it.effect('a subtask back under a parent whose delete waits keeps the parent', () => {
    // Sequence 880: the subtask moved out, its parent was deleted without
    // it, and the move was undone. Google deletes a parent's subtasks with
    // it: the delete went on and took the subtask the user had kept.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        network.down = true;
        yield* moveOf(mutations, PACK, 'list-1', 'list-2');
        yield* mutations.processPendingOps();
        yield* mutations.deleteTask({ accountId: ACCOUNT_ID, taskId: 'p', taskListId: 'list-1' });
        const [own] = yield* (yield* PendingOpRepo).listAll();
        yield* mutations.discardPendingOp(own!.id);
        expect(yield* placed).toEqual(['list-1/p', 'list-1/s1/p']);
        network.down = false;
        yield* drainAll(mutations);
        expect(google.taskOf('list-1', 'p')?.deleted).toBeUndefined();
        expect(google.taskOf('list-1', 's1')?.deleted).toBeUndefined();
        // The subtask deleted with the parent stays deleted.
        expect(google.taskOf('list-1', 's2')?.deleted).toBe(true);
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      }),
    );
  });

  it.effect('a pull leaves a deleted task gone where a move with a lost answer took it', () => {
    // Sequence 693: the move landed with its answer lost, the user deleted
    // the task in its new list, and a pull of that list — Google lists the
    // task there, its copy here still in the source — wrote it back.
    const google = newFake();
    const network = losingFirstMove(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        yield* moveOf(mutations, TRIP, 'list-1', 'list-2');
        yield* mutations.processPendingOps();
        expect(google.taskOf('list-2', 'p')).toBeDefined();
        yield* mutations.deleteTask({ accountId: ACCOUNT_ID, taskId: 'p', taskListId: 'list-2' });
        google.now += MINUTE;
        yield* TestClock.adjust('1 minute');
        yield* (yield* SyncEngine).syncAll();
        expect(yield* placed).toEqual([]);
        network.down = false;
        yield* drainAll(mutations);
        expect(google.tasksIn('list-2').map((task) => task.id)).toEqual(['t2']);
        expect(yield* placed).toEqual([]);
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
        expect(yield* copies).toEqual([]);
      }),
    );
  });

  it.effect('a subtask Google deleted while its parent’s move waits does not stay behind', () => {
    // Sequence 746: the pull reported the subtask deleted in the list
    // Google had it in, while its row sat in the list the queued move
    // shows it in. The row stayed there, pending, with nothing to settle it.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        network.down = true;
        yield* moveOf(mutations, TRIP, 'list-1', 'list-2');
        google.now += MINUTE;
        google.deleteTaskServerSide('list-1', 's2');
        google.now += MINUTE;
        yield* TestClock.adjust('2 minutes');
        yield* (yield* SyncEngine).syncAll();
        expect(yield* placed).toEqual(['list-2/p', 'list-2/s1/p']);
        network.down = false;
        yield* drainAll(mutations);
        expect(yield* placed).toEqual(['list-2/p', 'list-2/s1/p']);
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
        expect(yield* copies).toEqual([]);
      }),
    );
  });

  it.effect('a move that landed and whose task was deleted there since takes the task away', () => {
    // Sequence 1800: the move landed with its answer lost and another
    // device deleted the task in its new list. The retry's 404 put the
    // rows back in the source, where Google sends no tombstone for them.
    const google = newFake();
    const network = losingFirstMove(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        yield* moveOf(mutations, TRIP, 'list-1', 'list-2');
        yield* mutations.processPendingOps();
        // The subtask moved back on its own since, its move still queued.
        yield* moveOf(mutations, PACK, 'list-2', 'list-1');
        google.now += MINUTE;
        for (const id of ['s1', 's2', 'p']) {
          google.deleteTaskServerSide('list-2', id);
        }
        network.down = false;
        yield* drainAll(mutations);
        expect(yield* placed).toEqual([]);
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
        expect(yield* copies).toEqual([]);
      }),
    );
  });
});

/**
 * Gaps the sequences found that are not closed yet: each test shows one,
 * skipped until a change closes it (then it goes in the gate).
 */
describe('pending-op queue: open gaps the sequences found', () => {
  it.effect("a discard after a pull brought Google's newer copy shows Google's copy", () => {
    // Sequences 6, 8, 22 and 23: the pull skipped a row a queued op held
    // and its token moved past Google's copy; the discard put back the op's
    // snapshot, older than that copy, as synced — for good, since no pull
    // sends the copy again. Google's copy of a held event is kept beside
    // its row now, and the pull writes it there.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const engine = yield* SyncEngine;
        network.down = true;
        yield* mutations.updateEvent({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-1',
          changes: { title: 'Standup (moved)' },
          eventId: 'e1',
        });
        google.putEvent('cal-1', {
          ...google.eventOf('cal-1', 'e1')!,
          description: 'Agenda from another device',
        });
        yield* TestClock.adjust('1 minute');
        yield* engine.syncAll();
        const [op] = yield* (yield* PendingOpRepo).listAll();
        yield* mutations.discardPendingOp(op!.id);
        network.down = false;
        for (let round = 0; round < 2; round += 1) {
          yield* TestClock.adjust('2 minutes');
          yield* engine.syncAll();
        }
        const [row] = yield* (yield* SqlClient)<{
          readonly description: string | null;
        }>`SELECT description FROM events WHERE id = 'e1'`;
        expect(row?.description).toBe('Agenda from another device');
      }),
    );
  });

  it.effect('a task move discarded after it landed leaves the task where Google has it', () => {
    // Sequences 208, 281 and others: the move landed with its answer lost,
    // and the discard put the rows back in the source without asking
    // Google. Google sends the source no tombstone for a task that left
    // it: the task showed where it was for good, and an edit of it met a
    // 404. A sent move's discard asks the destination first now, as an
    // event move's does.
    const google = newFake();
    let loseMove = true;
    let down = false;
    google.fault = (call) => {
      if (call.method === 'GET') {
        return undefined;
      }
      if (loseMove && call.url.includes('/move')) {
        loseMove = false;
        down = true;
        return 'lost';
      }
      return down ? 'refused' : undefined;
    };
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const engine = yield* SyncEngine;
        yield* mutations.moveTask({
          accountId: ACCOUNT_ID,
          draft: { dueDate: due(7).slice(0, 10), title: 'Call' },
          target: { accountId: ACCOUNT_ID, taskListId: 'list-1' },
          taskId: 't2',
          taskListId: 'list-2',
        });
        yield* mutations.processPendingOps();
        expect(google.taskOf('list-1', 't2')).toBeDefined();
        // A pull while the move waits: the moved row is held, the copy in
        // list-1 skipped, and the watermark moves past it.
        google.now += 2 * MINUTE;
        yield* TestClock.adjust('2 minutes');
        yield* engine.syncAll();
        const [op] = yield* (yield* PendingOpRepo).listAll();
        yield* mutations.discardPendingOp(op!.id);
        down = false;
        for (let round = 0; round < 2; round += 1) {
          google.now += 2 * MINUTE;
          yield* TestClock.adjust('2 minutes');
          yield* engine.syncAll();
        }
        const rows = yield* (yield* SqlClient)<{
          readonly list_id: string;
        }>`SELECT list_id FROM tasks WHERE id = 't2'`;
        expect(rows.map((row) => row.list_id)).toEqual(['list-1']);
      }),
    );
  });

  it.effect('a change to a subtask whose parent’s delete waits is refused', () => {
    // Sequence 864, as it was: the parent was deleted with its subtasks, a
    // pull put their copies back while the deletes waited, and the user
    // edited one subtask. Its own delete went, the parent's stayed ahead,
    // and Google deleted the subtask with its parent: the edit met a 404.
    // Nothing comes back while the deletes wait now, so there is nothing
    // to edit, and a change that names the task anyway is turned down.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const engine = yield* SyncEngine;
        network.down = true;
        yield* mutations.deleteTask({ accountId: ACCOUNT_ID, taskId: 'p', taskListId: 'list-1' });
        google.now += MINUTE;
        yield* TestClock.adjust('1 minute');
        yield* engine.syncAll();
        const edited = yield* Effect.result(
          mutations.updateTask({
            accountId: ACCOUNT_ID,
            changes: { notes: 'Passport' },
            taskId: 's1',
            taskListId: 'list-1',
          }),
        );
        expect(Result.isFailure(edited) && edited.failure).toMatchObject({
          _tag: 'TaskNotFoundError',
        });
        network.down = false;
        yield* mutations.retryPendingOps();
        yield* mutations.processPendingOps();
        expect(google.taskOf('list-1', 'p')?.deleted).toBe(true);
        expect(google.taskOf('list-1', 's1')?.deleted).toBe(true);
        expect(yield* (yield* PendingOpRepo).listAll()).toEqual([]);
      }),
    );
  });
});

// ---- the seeded series, for the scripted runs ----

/** `r1` (newFake): cal-1, daily, six times from its first start. */
const R1 = { accountId: ACCOUNT_ID, calendarId: 'cal-1', masterId: 'r1' };
const R1_START = START + 2 * DAY + 5 * HOUR;
/** `r2` (newFake): cal-2, daily, five times; its second occurrence moved, its third cancelled. */
const R2 = { accountId: ACCOUNT_ID, calendarId: 'cal-2', masterId: 'r2' };
const R2_START = START + 4 * DAY + HOUR;
const EVERY_OTHER_DAY = ['RRULE:FREQ=DAILY;INTERVAL=2;COUNT=4'];

/** Where Google draws a series, as starts. */
const drawnOnGoogle = (google: FakeGoogle, calendarId: string, masterId: string): Array<number> =>
  google
    .instancesOf(calendarId, masterId, WINDOW_FROM, WINDOW_TO)
    .map((instance) => Date.parse(instance.start?.dateTime ?? ''));

/** Where the client shows an event: `calendar status`, one entry per row. */
const shownAt = (eventId: string) =>
  Effect.gen(function* () {
    const rows = yield* (yield* SqlClient)<{
      readonly calendar_id: string;
      readonly sync_status: string;
    }>`SELECT calendar_id, sync_status FROM events WHERE id = ${eventId} ORDER BY calendar_id`;
    return rows.map((row) => `${row.calendar_id} ${row.sync_status}`);
  });

/** Discards whatever is still queued. */
const discardAll = (mutations: EventMutationsShape) =>
  Effect.gen(function* () {
    for (const op of yield* (yield* PendingOpRepo).listAll()) {
      yield* mutations.discardPendingOp(op.id);
    }
  });

const moveE1 = (mutations: EventMutationsShape, from: string, to: string) =>
  mutations.moveEvent({
    accountId: ACCOUNT_ID,
    calendarId: from,
    eventId: 'e1',
    target: { accountId: ACCOUNT_ID, calendarId: to },
  });

/** The first write of this kind lands with its answer lost; every later one is refused (503). */
const lostThenRefused = (google: FakeGoogle, matches: (call: FakeCall) => boolean) => {
  let lose = true;
  google.fault = (call) => {
    if (!matches(call)) {
      return undefined;
    }
    const fault = lose ? 'lost' : 'refused';
    lose = false;
    return fault;
  };
};

describe('pending-op queue: what a pull tells of a queued create or move', () => {
  it.effect('a create that landed is settled by the page that brings its event', () => {
    // The gap the first sequences named "a landed create's discard hides
    // an event Google has": the create's answer was lost, a pull brought
    // the event and skipped the pending row, and its token moved on. A
    // discard then took the row away for good.
    const google = newFake();
    lostThenRefused(google, (call) => call.method === 'POST');
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const created = yield* mutations.createEvent({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-1',
          endUtc: START + 9 * DAY + 11 * HOUR,
          isAllDay: false,
          startTimeZone: 'UTC',
          startUtc: START + 9 * DAY + 10 * HOUR,
          title: 'Dentist',
        });
        yield* mutations.processPendingOps();
        yield* TestClock.adjust('1 minute');
        yield* (yield* SyncEngine).syncAll();
        expect((yield* (yield* PendingOpRepo).listAll()).map(describeOp)).toEqual([]);
        yield* discardAll(mutations);
        expect(yield* shownAt(created.id)).toEqual(['cal-1 synced']);
        expect(google.eventOf('cal-1', created.id)?.summary).toBe('Dentist');
      }),
    );
  });

  it.effect('a move that landed is settled by the page of the calendar it went to', () => {
    // A move's answer was lost, both pages told of it (gone here, there
    // now) and were skipped, and a discard that Google did not answer put
    // the event back in its source, where Google has it no more.
    const google = newFake();
    lostThenRefused(
      google,
      (call) => call.url.includes('/move') || /\/events\/e1$/.test(new URL(call.url).pathname),
    );
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        yield* moveE1(mutations, 'cal-1', 'cal-2');
        yield* mutations.processPendingOps();
        yield* TestClock.adjust('1 minute');
        yield* (yield* SyncEngine).syncAll();
        expect((yield* (yield* PendingOpRepo).listAll()).map(describeOp)).toEqual([]);
        yield* discardAll(mutations);
        expect(yield* shownAt('e1')).toEqual(['cal-2 synced']);
      }),
    );
  });

  it.effect('a move Google never makes puts nothing back where a pull found the event gone', () => {
    // Another device deleted the event while its move waited: the source's
    // page said so and its token moved on. The move then met a 404, the
    // destination had no such event either, and the rows went back to the
    // source as Google's, for good.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        network.down = true;
        yield* moveE1(mutations, 'cal-1', 'cal-2');
        google.deleteEventServerSide('cal-1', 'e1');
        yield* TestClock.adjust('1 minute');
        yield* (yield* SyncEngine).syncAll();
        network.down = false;
        yield* drainAll(mutations);
        expect((yield* (yield* PendingOpRepo).listAll()).map(describeOp)).toEqual([]);
        expect(yield* shownAt('e1')).toEqual([]);
      }),
    );
  });

  it.effect('a move back keeps its rows when a page tells of the move out before it', () => {
    // The event went to another calendar and comes back while offline. The
    // page of the calendar it comes back to still reports it gone (the
    // first move); that deleted the rows the move back had put there, and
    // its landing found none to settle.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        yield* moveE1(mutations, 'cal-1', 'cal-2');
        yield* mutations.processPendingOps();
        network.down = true;
        yield* moveE1(mutations, 'cal-2', 'cal-1');
        yield* TestClock.adjust('1 minute');
        yield* (yield* SyncEngine).syncAll();
        expect(yield* shownAt('e1')).toEqual(['cal-1 pending']);
        network.down = false;
        yield* drainAll(mutations);
        expect((yield* (yield* PendingOpRepo).listAll()).map(describeOp)).toEqual([]);
        expect(yield* shownAt('e1')).toEqual(['cal-1 synced']);
        expect(google.eventOf('cal-1', 'e1')?.summary).toBe('Standup');
      }),
    );
  });

  it.effect('news of an event its queued move takes out of the calendar reaches its rows', () => {
    // Sequence 2443: another device renamed the event, then it was moved
    // while offline. The page of the calendar it leaves left it out —
    // written there, it showed in both calendars — and its token moved
    // on: given up, the move put the old title back for good.
    const google = newFake();
    const network = writesDown(google);
    const titles = Effect.gen(function* () {
      const rows = yield* (yield* SqlClient)<{
        readonly calendar_id: string;
        readonly sync_status: string;
        readonly title: string;
      }>`SELECT calendar_id, sync_status, title FROM events WHERE id = 'e3'`;
      return rows.map((row) => `${row.calendar_id} ${row.sync_status} ${row.title}`);
    });
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        google.patchEventServerSide('cal-2', 'e3', { summary: 'Review (moved room)' });
        network.down = true;
        yield* mutations.moveEvent({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-2',
          eventId: 'e3',
          target: { accountId: ACCOUNT_ID, calendarId: 'cal-1' },
        });
        yield* TestClock.adjust('1 minute');
        yield* (yield* SyncEngine).syncAll();
        // Where its rows are: in the calendar the move takes it to.
        expect(yield* titles).toEqual(['cal-1 pending Review (moved room)']);
        // Never sent, the move goes back at once.
        yield* discardAll(mutations);
        expect(yield* titles).toEqual(['cal-2 synced Review (moved room)']);
      }),
    );
  });

  it.effect('the occurrences of a series take what the page that settles its move brings', () => {
    // Sequences 1148 and 1777: the series' move landed with its answer
    // lost, and another device renamed it in its new calendar, which
    // Google copies onto every exception. The page brought the master and
    // the exceptions; their rows were still the move's, and were skipped.
    const google = newFake();
    lostThenRefused(google, (call) => call.url.includes('/move'));
    const moved = googleInstanceId('r2', R2_START + DAY, false);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        yield* mutations.moveEvent({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-2',
          eventId: 'r2',
          target: { accountId: ACCOUNT_ID, calendarId: 'cal-1' },
        });
        yield* mutations.processPendingOps();
        google.patchEventServerSide('cal-1', 'r2', { summary: 'Sprint review' });
        yield* TestClock.adjust('1 minute');
        yield* (yield* SyncEngine).syncAll();
        expect((yield* (yield* PendingOpRepo).listAll()).map(describeOp)).toEqual([]);
        const rows = yield* (yield* SqlClient)<{
          readonly calendar_id: string;
          readonly sync_status: string;
          readonly title: string;
        }>`SELECT calendar_id, sync_status, title FROM events WHERE id IN ('r2', ${moved}) ORDER BY id`;
        expect(rows).toEqual([
          { calendar_id: 'cal-1', sync_status: 'synced', title: 'Sprint review' },
          { calendar_id: 'cal-1', sync_status: 'synced', title: 'Sprint review' },
        ]);
      }),
    );
  });
});

/** The account's own answer on an event's row. */
const selfResponse = (eventId: string) =>
  Effect.gen(function* () {
    const rows = yield* (yield* SqlClient)<{
      readonly attendees: string | null;
    }>`SELECT attendees FROM events WHERE id = ${eventId}`;
    const guests = JSON.parse(rows[0]?.attendees ?? '[]') as ReadonlyArray<{
      readonly email?: string;
      readonly responseStatus?: string;
    }>;
    return guests.find((guest) => guest.email === EMAIL)?.responseStatus;
  });

/** An edit of e1. */
const editE1 = (
  mutations: EventMutationsShape,
  changes: { readonly description?: string; readonly title?: string },
) => mutations.updateEvent({ accountId: ACCOUNT_ID, calendarId: 'cal-1', changes, eventId: 'e1' });

describe("pending-op queue: Google's copy and the changes laid over it", () => {
  it.effect('a second edit of an event whose edit is parked stays parked', () => {
    // Both renamed the event, and a pull parked the user's rename. The row
    // then carries Google's etag (it is Google's version with the user's
    // title over it): a second edit replaced the parked op with one on
    // that etag, the PATCH went through, and Google's title was gone
    // without anyone having been asked.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const ops = yield* PendingOpRepo;
        network.down = true;
        yield* editE1(mutations, { title: 'Standup (mine)' });
        google.patchEventServerSide('cal-1', 'e1', { summary: 'Standup (theirs)' });
        yield* TestClock.adjust('1 minute');
        yield* (yield* SyncEngine).syncAll();
        expect((yield* ops.listAll()).map((op) => op.conflictAt !== undefined)).toEqual([true]);
        yield* editE1(mutations, { description: 'Bring the numbers' });
        network.down = false;
        yield* drainAll(mutations);
        expect(google.eventOf('cal-1', 'e1')?.summary).toBe('Standup (theirs)');
        const [parked] = yield* ops.listAll();
        expect(parked?.conflictAt).toBeDefined();
        expect(parked?.payload?.title).toBe('Standup (mine)');
        expect(parked?.payload?.description).toBe('Bring the numbers');
        expect(parked?.beforePayload?.title).toBe('Standup (theirs)');
      }),
    );
  });

  it.effect(
    'a full list that brings an unchanged event leaves a queued guest-list edit alone',
    () => {
      // After an expired token the calendar is listed in full: every held
      // event comes again, changed or not. A guest-list edit differs from
      // Google's list by its nature, and parked as "changed on Google".
      const google = newFake();
      const network = writesDown(google);
      return scripted(
        google,
        Effect.gen(function* () {
          const mutations = yield* EventMutations;
          network.down = true;
          yield* mutations.updateEvent({
            accountId: ACCOUNT_ID,
            calendarId: 'cal-1',
            changes: {
              attendees: [
                new Attendee({ email: 'guest@example.com', responseStatus: 'needsAction' }),
              ],
            },
            eventId: 'e1',
          });
          google.expireSyncTokens('cal-1');
          yield* TestClock.adjust('1 minute');
          yield* (yield* SyncEngine).syncAll();
          const [queued] = yield* (yield* PendingOpRepo).listAll();
          expect(queued?.kind).toBe('update');
          expect(queued?.conflictAt).toBeUndefined();
        }),
      );
    },
  );

  it.effect('an answer queued before an edit stays on the row through a pull', () => {
    // The user accepted, then renamed; the organizer wrote a description.
    // The pull laid the rename over Google's version, guests and all, and
    // the row showed "not answered" again until the rename landed.
    const google = newFake();
    google.putEvent('cal-1', {
      ...timed('invite', 6, 9, 'Planning'),
      attendees: [
        { email: EMAIL, responseStatus: 'needsAction', self: true },
        { email: 'host@example.com', organizer: true, responseStatus: 'accepted' },
      ],
      organizer: { email: 'host@example.com' },
    });
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        network.down = true;
        yield* mutations.respondToEvent({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-1',
          eventId: 'invite',
          response: 'accepted',
        });
        yield* mutations.updateEvent({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-1',
          changes: { title: 'Planning (mine)' },
          eventId: 'invite',
        });
        expect(yield* selfResponse('invite')).toBe('accepted');
        google.patchEventServerSide('cal-1', 'invite', { description: 'Agenda attached' });
        yield* TestClock.adjust('1 minute');
        yield* (yield* SyncEngine).syncAll();
        expect(yield* selfResponse('invite')).toBe('accepted');
      }),
    );
  });

  it.effect(
    "an edit behind an answer keeps what the answer's reply brought of another device",
    () => {
      // The organizer wrote a description after the last pull. The user
      // accepted and renamed: the answer met a 412, went again unchecked and
      // came back with that description, which became Google's copy as it
      // stood. The rename behind it was not laid over it: its payload still
      // held the old, empty description, read as the user's own change, and
      // the PATCH wrote it over the organizer's.
      const google = newFake();
      google.putEvent('cal-1', {
        ...timed('invite', 6, 9, 'Planning'),
        attendees: [
          { email: EMAIL, responseStatus: 'needsAction', self: true },
          { email: 'host@example.com', organizer: true, responseStatus: 'accepted' },
        ],
        organizer: { email: 'host@example.com' },
      });
      const network = writesDown(google);
      return scripted(
        google,
        Effect.gen(function* () {
          const mutations = yield* EventMutations;
          network.down = true;
          yield* mutations.respondToEvent({
            accountId: ACCOUNT_ID,
            calendarId: 'cal-1',
            eventId: 'invite',
            response: 'accepted',
          });
          yield* mutations.updateEvent({
            accountId: ACCOUNT_ID,
            calendarId: 'cal-1',
            changes: { title: 'Planning (mine)' },
            eventId: 'invite',
          });
          google.patchEventServerSide('cal-1', 'invite', { description: 'Agenda attached' });
          network.down = false;
          yield* drainAll(mutations);
          expect((yield* (yield* PendingOpRepo).listAll()).map(describeOp)).toEqual([]);
          const theirs = google.eventOf('cal-1', 'invite');
          expect(theirs?.summary).toBe('Planning (mine)');
          expect(theirs?.description).toBe('Agenda attached');
          expect(yield* selfResponse('invite')).toBe('accepted');
        }),
      );
    },
  );

  it.effect('an event deleted while its create was out does not come back with a pull', () => {
    // The create's answer was lost and the user deleted the event: its
    // delete waits behind the create. The page that brings the event wrote
    // it as a row again, there until the delete was sent.
    const google = newFake();
    lostThenRefused(google, (call) => call.method === 'POST' || call.method === 'DELETE');
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const created = yield* mutations.createEvent({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-1',
          endUtc: START + 9 * DAY + 11 * HOUR,
          isAllDay: false,
          startTimeZone: 'UTC',
          startUtc: START + 9 * DAY + 10 * HOUR,
          title: 'Dentist',
        });
        yield* mutations.processPendingOps();
        yield* mutations.deleteEvent({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-1',
          eventId: created.id,
        });
        yield* TestClock.adjust('1 minute');
        yield* (yield* SyncEngine).syncAll();
        expect(yield* shownAt(created.id)).toEqual([]);
        expect((yield* (yield* PendingOpRepo).listAll()).map((op) => op.kind)).toEqual(['delete']);
        google.fault = undefined;
        yield* drainAll(mutations);
        expect((yield* (yield* PendingOpRepo).listAll()).map(describeOp)).toEqual([]);
        expect(yield* shownAt(created.id)).toEqual([]);
      }),
    );
  });
});

describe('pending-op queue: an occurrence changed under a queued change of its series', () => {
  it.effect("an occurrence's change waits for the retime of its series it was made under", () => {
    // Sequence 931 of the first search: all events an hour later, then the
    // second occurrence renamed at its new time, both while offline. An
    // occurrence's op waited for a create or a new rule of its series
    // ahead of it, not for new times: the series' PATCH waited out one
    // more 503, the occurrence's went first, found no such slot on Google
    // (404), and the rename was dropped. It waits for any change of its
    // series ahead of it now.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        network.down = true;
        yield* mutations.updateRecurring({
          ...R1,
          changes: { endUtc: R1_START + 2 * HOUR, startUtc: R1_START + HOUR },
          originalStartUtc: R1_START,
          scope: 'series',
        });
        const second = R1_START + DAY + HOUR;
        yield* mutations.updateRecurring({
          ...R1,
          changes: { title: 'Yoga (second)' },
          originalStartUtc: second,
          scope: 'instance',
        });
        // Back online, the series' PATCH meets one more 503.
        let refuse = true;
        google.fault = (call) => {
          if (refuse && call.method === 'PATCH' && call.url.endsWith('/events/r1')) {
            refuse = false;
            return 'refused';
          }
          return undefined;
        };
        yield* drainAll(mutations);
        expect(google.eventOf('cal-1', googleInstanceId('r1', second, false))?.summary).toBe(
          'Yoga (second)',
        );
      }),
    );
  });

  it.effect("an occurrence's own text goes after the text of its series set before it", () => {
    // Sequence 1 of the search on the merged branch: all events got a
    // location, then one occurrence its own, both while offline. The
    // series' PATCH waited out one more 503, the occurrence's went first,
    // and Google copied the series' location over it when that landed
    // (verified live: a changed text goes onto every exception).
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        network.down = true;
        yield* mutations.updateRecurring({
          ...R1,
          changes: { location: 'Room 1' },
          originalStartUtc: R1_START,
          scope: 'series',
        });
        const second = R1_START + DAY;
        yield* mutations.updateRecurring({
          ...R1,
          changes: { location: 'Room 2' },
          originalStartUtc: second,
          scope: 'instance',
        });
        let refuse = true;
        google.fault = (call) => {
          if (refuse && call.method === 'PATCH' && call.url.endsWith('/events/r1')) {
            refuse = false;
            return 'refused';
          }
          return undefined;
        };
        yield* drainAll(mutations);
        expect(google.eventOf('cal-1', 'r1')?.location).toBe('Room 1');
        expect(google.eventOf('cal-1', googleInstanceId('r1', second, false))?.location).toBe(
          'Room 2',
        );
      }),
    );
  });
});

describe("pending-op queue: a series' create that is discarded", () => {
  it.effect("discarding a series' create takes the queued changes of its occurrences along", () => {
    // Sequences 290, 436, 524, 545, 611, 730 and 738 of the first search:
    // a discarded create took what was queued behind it for the event's
    // own id. An occurrence's op has an id of its own (`<id>_<start>`):
    // it stayed, with its row, and met a 404 once it was sent — the
    // series a this-and-following edit splits off included.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const ops = yield* PendingOpRepo;
        network.down = true;
        const created = yield* mutations.createEvent({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-1',
          endUtc: START + 9 * DAY + 11 * HOUR,
          isAllDay: false,
          recurrence: ['RRULE:FREQ=DAILY;COUNT=5'],
          startTimeZone: 'UTC',
          startUtc: START + 9 * DAY + 10 * HOUR,
          title: 'Physio',
        });
        yield* mutations.updateRecurring({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-1',
          changes: { title: 'Physio (second)' },
          masterId: created.id,
          originalStartUtc: created.startUtc + DAY,
          scope: 'instance',
        });
        const create = (yield* ops.listAll()).find((op) => op.kind === 'create')!;
        yield* mutations.discardPendingOp(create.id);
        expect((yield* ops.listAll()).map(describeOp)).toEqual([]);
        const rows = yield* (yield* SqlClient)<{
          readonly id: string;
        }>`SELECT id FROM events WHERE id LIKE ${`${created.id}%`}`;
        expect(rows).toEqual([]);
        network.down = false;
        google.requests.length = 0;
        yield* drainAll(mutations);
        expect(writes(google)).toEqual([]);
      }),
    );
  });
});

describe('pending-op queue: a delete of an occurrence that a pull confirmed', () => {
  it.effect(
    "an occurrence's delete a pull confirmed, discarded, leaves its tombstone synced",
    () => {
      // Sequences 20, 172 and 835 of the first search: the delete landed
      // with its answer lost, and a pull reported the occurrence cancelled.
      // That tombstone is Google's copy now, so a discard has it to put
      // back: synced, where the delete's own tombstone used to stay
      // pending with no op, for good.
      const google = newFake();
      let lose = true;
      google.fault = (call) => {
        if (call.method !== 'DELETE') {
          return undefined;
        }
        const fault = lose ? 'lost' : 'refused';
        lose = false;
        return fault;
      };
      return scripted(
        google,
        Effect.gen(function* () {
          const mutations = yield* EventMutations;
          const second = R1_START + DAY;
          yield* mutations.deleteRecurring({ ...R1, originalStartUtc: second, scope: 'instance' });
          yield* mutations.processPendingOps();
          yield* TestClock.adjust('1 minute');
          yield* (yield* SyncEngine).syncAll();
          const [op] = yield* (yield* PendingOpRepo).listAll();
          yield* mutations.discardPendingOp(op!.id);
          const rows = yield* (yield* SqlClient)<{
            readonly status: string;
            readonly sync_status: string;
          }>`SELECT status, sync_status FROM events
          WHERE id = ${googleInstanceId('r1', second, false)}`;
          expect(rows).toEqual([{ status: 'cancelled', sync_status: 'synced' }]);
        }),
      );
    },
  );
});

/**
 * Gaps the series steps found, each on its own and skipped until a change
 * closes it. Every one is about what the queue does around a series: what
 * Google does is as recorded (docs/google-sync-and-testing.md, Events &
 * recurrence) and as the fake mirrors it.
 */
describe('pending-op queue: open gaps the sequences found in series', () => {
  it.effect.skip(
    'discarding a new rule takes along the change of an occurrence only it draws',
    () => {
      // Sequences 215 and 656: every other day draws September 1, which the
      // six days of the series do not. The occurrence there was renamed,
      // then the new rule discarded (656: given up for Google's copy after a
      // conflict). The rename stayed queued, with its row at a slot the
      // series no longer draws, and met a 404 once it was sent.
      const google = newFake();
      const network = writesDown(google);
      return scripted(
        google,
        Effect.gen(function* () {
          const mutations = yield* EventMutations;
          const ops = yield* PendingOpRepo;
          network.down = true;
          yield* mutations.updateRecurring({
            ...R1,
            changes: { recurrence: EVERY_OTHER_DAY },
            originalStartUtc: R1_START,
            scope: 'series',
          });
          const added = R1_START + 6 * DAY;
          yield* mutations.updateRecurring({
            ...R1,
            changes: { title: 'Yoga (last)' },
            originalStartUtc: added,
            scope: 'instance',
          });
          const rule = (yield* ops.listAll()).find((op) => op.eventId === 'r1')!;
          yield* mutations.discardPendingOp(rule.id);
          network.down = false;
          google.requests.length = 0;
          yield* drainAll(mutations);
          expect(writes(google)).toEqual([]);
          const rows = yield* (yield* SqlClient)<{
            readonly id: string;
          }>`SELECT id FROM events WHERE id = ${googleInstanceId('r1', added, false)}`;
          expect(rows).toEqual([]);
        }),
      );
    },
  );

  it.effect.skip(
    'an occurrence deleted under a new rule stays deleted when the series is edited again',
    () => {
      // Sequence 77: every other day draws September 1; that occurrence was
      // deleted, then all events got a location. The edit replaced the queued
      // rule change and went to the back of the queue, behind the
      // occurrence's delete, which waits only for a rule change ahead of it:
      // it went first, found no such slot on Google (404) and counted as
      // done. Then the new rule landed, and Google draws the day the user
      // deleted.
      const google = newFake();
      const network = writesDown(google);
      return scripted(
        google,
        Effect.gen(function* () {
          const mutations = yield* EventMutations;
          network.down = true;
          yield* mutations.updateRecurring({
            ...R1,
            changes: { recurrence: EVERY_OTHER_DAY },
            originalStartUtc: R1_START,
            scope: 'series',
          });
          yield* mutations.deleteRecurring({
            ...R1,
            originalStartUtc: R1_START + 6 * DAY,
            scope: 'instance',
          });
          yield* mutations.updateRecurring({
            ...R1,
            changes: { location: 'Studio 2' },
            originalStartUtc: R1_START,
            scope: 'series',
          });
          network.down = false;
          yield* drainAll(mutations);
          expect(drawnOnGoogle(google, 'cal-1', 'r1')).toEqual([
            R1_START,
            R1_START + 2 * DAY,
            R1_START + 4 * DAY,
          ]);
        }),
      );
    },
  );

  it.effect.skip('the deletes a rule change queued go with it when a delete replaces it', () => {
    // Sequence 576 (1347 and 2936 with a this-and-following cut and a
    // delete of the series): "does not repeat" queues, behind its PATCH, a
    // delete of each exception; the PATCH's landing takes them off the
    // queue, since Google cancels them with it. Deleting the event, single
    // by then, replaced the PATCH — and its deletes went out on their own:
    // the one of an occurrence Google held cancelled all along met a 410,
    // the one of the moved occurrence cancelled it. With the event's
    // delete discarded, Google has the series as it was, less that
    // occurrence.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const ops = yield* PendingOpRepo;
        network.down = true;
        yield* mutations.updateRecurring({
          ...R2,
          changes: { recurrence: null },
          originalStartUtc: R2_START,
          scope: 'series',
        });
        yield* mutations.deleteEvent({ accountId: ACCOUNT_ID, calendarId: 'cal-2', eventId: 'r2' });
        // Back online, the event's own delete still fails.
        google.fault = (call) =>
          call.method === 'DELETE' && call.url.endsWith('/events/r2') ? 'refused' : undefined;
        yield* drainAll(mutations);
        const remove = (yield* ops.listAll()).find((op) => op.eventId === 'r2')!;
        yield* mutations.discardPendingOp(remove.id);
        expect(google.eventOf('cal-2', googleInstanceId('r2', R2_START + DAY, false))?.status).toBe(
          'confirmed',
        );
        expect(drawnOnGoogle(google, 'cal-2', 'r2')).toHaveLength(4);
      }),
    );
  });

  it.effect.skip(
    "a move of an event whose rule was cleared takes its occurrences' rows along",
    () => {
      // Sequence 2323 (past the first thousand; 2138 with an exception a pull
      // brought): one occurrence deleted, then "does not repeat", then the
      // event moved, all while offline. The move takes a series' exception
      // rows along; this event repeats no more here, so only the ops of its
      // occurrences went to the destination, and the deleted occurrence's
      // tombstone stayed in the source: pending, with no op there, for good.
      const google = newFake();
      const network = writesDown(google);
      return scripted(
        google,
        Effect.gen(function* () {
          const mutations = yield* EventMutations;
          network.down = true;
          yield* mutations.deleteRecurring({
            ...R1,
            originalStartUtc: R1_START + DAY,
            scope: 'instance',
          });
          yield* mutations.updateRecurring({
            ...R1,
            changes: { recurrence: null },
            originalStartUtc: R1_START,
            scope: 'series',
          });
          yield* mutations.moveEvent({
            accountId: ACCOUNT_ID,
            calendarId: 'cal-1',
            eventId: 'r1',
            target: { accountId: ACCOUNT_ID, calendarId: 'cal-2' },
          });
          network.down = false;
          yield* drainAll(mutations);
          yield* TestClock.adjust('1 minute');
          yield* (yield* SyncEngine).syncAll();
          expect((yield* (yield* PendingOpRepo).listAll()).map(describeOp)).toEqual([]);
          const rows = yield* (yield* SqlClient)<{
            readonly calendar_id: string;
            readonly id: string;
            readonly sync_status: string;
          }>`SELECT calendar_id, id, sync_status FROM events
          WHERE id LIKE 'r1%' AND (calendar_id = 'cal-1' OR sync_status != 'synced')`;
          expect(rows).toEqual([]);
        }),
      );
    },
  );

  it.effect.skip('a change made after a discarded move that had landed is kept', () => {
    // Sequences 1876 and 2506 (past the first thousand; 2506 with a cut in
    // place of the move): a move landed with its answer lost and was
    // discarded while Google could not be asked where the event is. It
    // went back to its source, as a move that never reached Google would,
    // and until the next pull the user saw it there: a change made then
    // met a 404 and was dropped. A discarded change Google may have is
    // only settled once Google answers; until then it would have to wait.
    const google = newFake();
    lostThenRefused(
      google,
      (call) => call.url.includes('/move') || /\/events\/e1$/.test(new URL(call.url).pathname),
    );
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        yield* moveE1(mutations, 'cal-1', 'cal-2');
        yield* mutations.processPendingOps();
        yield* discardAll(mutations);
        google.fault = undefined;
        yield* mutations.updateEvent({
          accountId: ACCOUNT_ID,
          calendarId: 'cal-1',
          changes: { title: 'Standup (new room)' },
          eventId: 'e1',
        });
        yield* drainAll(mutations);
        yield* TestClock.adjust('1 minute');
        yield* (yield* SyncEngine).syncAll();
        expect(google.eventOf('cal-2', 'e1')?.summary).toBe('Standup (new room)');
      }),
    );
  });

  it.effect.skip('an occurrence keeps its own text through a later edit of its series', () => {
    // Sequences 485 and 524, and 1080, 2513 and 2801 past the first
    // thousand, each its own way to the same end: all events
    // got a location, then one occurrence its own, then all events a title,
    // all while offline. The second edit of the series replaced the first
    // one's op and sends both fields in one PATCH; the location differs
    // from Google's, so Google copies it onto every exception (verified
    // live), over the occurrence's own, which the user set after it. The
    // app writes the same over the occurrence's row as the title is saved.
    const google = newFake();
    const network = writesDown(google);
    return scripted(
      google,
      Effect.gen(function* () {
        const mutations = yield* EventMutations;
        const series = { ...R2, originalStartUtc: R2_START, scope: 'series' as const };
        const moved = R2_START + DAY;
        network.down = true;
        yield* mutations.updateRecurring({ ...series, changes: { location: 'Room 1' } });
        yield* mutations.updateRecurring({
          ...R2,
          changes: { location: 'Room 2' },
          originalStartUtc: moved,
          scope: 'instance',
        });
        yield* mutations.updateRecurring({ ...series, changes: { title: 'Sprint review' } });
        network.down = false;
        yield* drainAll(mutations);
        expect(google.eventOf('cal-2', googleInstanceId('r2', moved, false))).toMatchObject({
          location: 'Room 2',
          summary: 'Sprint review',
        });
      }),
    );
  });
});
