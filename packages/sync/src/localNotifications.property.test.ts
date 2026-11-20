import { unavailableAppleCalendarClient } from '@calendar/apple-calendar';
import { ContactsClient, makeFakeContactsClient } from '@calendar/contacts';
import {
  Account,
  APPLE_REMINDERS_ACCOUNT_ID,
  CalendarInfo,
  EventRecord,
  EventReminders,
  MAX_REMINDER_MINUTES,
  type PlannedNotification,
  ReminderOverride,
  TaskListInfo,
  TaskRecord,
} from '@calendar/core';
import {
  AccountRepo,
  CalendarRepo,
  EventRepo,
  reposLayer,
  runMigrations,
  TaskRepo,
} from '@calendar/db';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Clock, Effect, Layer, Schema } from 'effect';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { TestClock } from 'effect/testing';
import { appleCalendarServicesLayer } from './appleCalendarEvents.ts';
import { DeviceContacts } from './deviceContacts.ts';
import { writeEventNotificationSettings, writeTaskNotificationSettings } from './deviceSettings.ts';
import { LocalNotifications } from './localNotifications.ts';
import {
  type DeliveredNotification,
  NotificationSink,
  type NotificationSinkShape,
} from './notificationSink.ts';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const ACCOUNT = 'acc-1';
const CALENDAR = 'cal-1';
const GOOGLE_LIST = 'inbox';
const APPLE_LIST = 'ek-errands';
/** A repeating event here is daily, this many times. */
const SERIES_COUNT = 5;
/** The calendar's own default reminder. */
const DEFAULT_MINUTES = 30;
/** What a row pulled from another device carries: an edit made this long before it landed. */
const EARLIER_MS = 3 * DAY;
/** The spec's rules, restated: what the scheduler documents, never read from its module. */
const SCHEDULE_SLOTS = 60;
const ABSENT_GRACE_MS = 60_000;
const EVENT_LOOKBACK_MS = 12 * HOUR;
const HORIZON_MS = 7 * DAY;
const TASK_HORIZON_DAYS = 7;

// ---------------------------------------------------------------------------
// The oracle's clock: Intl's reading of a zone, never Temporal's arithmetic.

const formatters = new Map<string, Intl.DateTimeFormat>();
const wallCache = new Map<string, number>();

/** The wall clock `zone` shows at `utc`, to the minute, as if that reading were UTC. */
const wallAsUtc = (utc: number, zone: string): number => {
  const cacheKey = `${zone}|${String(utc)}`;
  const cached = wallCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  let formatter = formatters.get(zone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      day: '2-digit',
      hour: '2-digit',
      hourCycle: 'h23',
      minute: '2-digit',
      month: '2-digit',
      timeZone: zone,
      year: 'numeric',
    });
    formatters.set(zone, formatter);
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(utc).map((part) => [part.type, part.value]),
  );
  const wall = Date.UTC(
    Number(parts['year']),
    Number(parts['month']) - 1,
    Number(parts['day']),
    Number(parts['hour']),
    Number(parts['minute']),
  );
  wallCache.set(cacheKey, wall);
  return wall;
};

const offsetAt = (utc: number, zone: string): number => wallAsUtc(utc, zone) - utc;

const utcDay = (date: string): number => Date.parse(`${date}T00:00:00Z`);

const addDays = (date: string, days: number): string =>
  new Date(utcDay(date) + days * DAY).toISOString().slice(0, 10);

/** The day `zone`'s clock shows at `utc`. */
const localDate = (utc: number, zone: string): string =>
  new Date(wallAsUtc(utc, zone)).toISOString().slice(0, 10);

/** 'HH:MM' that `zone`'s clock shows at `utc`. */
const localTime = (utc: number, zone: string): string =>
  new Date(wallAsUtc(utc, zone)).toISOString().slice(11, 16);

/**
 * The instant `zone`'s clock first reads `time` on `date`. A time a
 * transition skips is read with the offset before it (the clock then
 * shows that much later), a time it repeats as the earlier of the two:
 * RFC 5545's reading, and what a person setting an alarm expects.
 */
const zonedInstant = (date: string, time: string, zone: string): number => {
  const [hour = 0, minute = 0] = time.split(':').map(Number);
  const wall = utcDay(date) + (hour * 60 + minute) * MINUTE;
  const before = offsetAt(wall - 2 * DAY, zone);
  const after = offsetAt(wall + 2 * DAY, zone);
  const readings = [...new Set([before, after])]
    .map((offset) => wall - offset)
    .filter((utc) => wallAsUtc(utc, zone) === wall)
    .sort((a, b) => a - b);
  return readings[0] ?? wall - before;
};

const startOfDay = (date: string, zone: string): number => zonedInstant(date, '00:00', zone);

const transitions = new Map<string, number>();

/** The first instant after `after` at which `zone` moves its clock forward or back. */
const transitionAfter = (zone: string, direction: 'back' | 'forward', after: number): number => {
  const from = Math.ceil(after / HOUR) * HOUR;
  const cacheKey = `${zone}|${direction}|${String(from)}`;
  const cached = transitions.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  // Every transition of these zones falls on a whole UTC hour.
  for (let utc = from; utc < from + 400 * DAY; utc += HOUR) {
    const change = offsetAt(utc + HOUR, zone) - offsetAt(utc, zone);
    if (direction === 'forward' ? change > 0 : change < 0) {
      transitions.set(cacheKey, utc + HOUR);
      return utc + HOUR;
    }
  }
  throw new Error(`${zone} moves its clock ${direction} nowhere within 400 days`);
};

/** The days between two dates. */
const daysFrom = (from: string, to: string): number =>
  Math.round((utcDay(to) - utcDay(from)) / DAY);

// ---------------------------------------------------------------------------
// Generated input.

const HomeZone = Schema.Literals([
  'America/New_York',
  'America/Santiago',
  'Australia/Sydney',
  'Europe/Vienna',
]);
const AnyZone = Schema.Literals([
  'America/New_York',
  'America/Santiago',
  'Australia/Sydney',
  'Europe/Vienna',
  'UTC',
]);
/** Ordinary times, and ones a transition skips or repeats in one of the zones. */
const WallTime = Schema.Literals(['00:00', '00:30', '01:30', '02:30', '09:00', '23:30']);
const Day = Schema.Int.check(Schema.isBetween({ maximum: 8, minimum: -1 }));
const Index = Schema.Int.check(Schema.isBetween({ maximum: 15, minimum: 0 }));
const Minutes = Schema.Literals([0, 10, 60, 420, 900, 1440]);
const Reminders = Schema.Union([
  Schema.Literal('default'),
  Schema.Array(Minutes).check(Schema.isMaxLength(3)),
]);
/** 'now': written here; 'earlier': an edit made on another device, landing now. */
const Stamp = Schema.Literals(['earlier', 'now']);
const Title = Schema.Literals(['Dentist', 'Flight', 'Rent', 'Standup']);

const Command = Schema.Union([
  Schema.Struct({
    allDay: Schema.Boolean,
    day: Day,
    kind: Schema.Literal('addEvent'),
    length: Schema.Literals([0, 30, 90]),
    reminders: Reminders,
    repeat: Schema.Boolean,
    stamp: Stamp,
    time: WallTime,
    title: Title,
  }),
  Schema.Struct({
    day: Day,
    index: Index,
    kind: Schema.Literal('editEvent'),
    reminders: Reminders,
    stamp: Stamp,
    time: WallTime,
    title: Title,
  }),
  Schema.Struct({ index: Index, kind: Schema.Literal('deleteEvent') }),
  Schema.Struct({
    day: Day,
    kind: Schema.Literal('addTask'),
    stamp: Stamp,
    time: WallTime,
    /** A Google task (date only), or a reminder: date only, at a floating time, at an instant. */
    timing: Schema.Literals(['google', 'reminder', 'floating', 'zoned']),
    title: Title,
  }),
  Schema.Struct({
    day: Day,
    index: Index,
    kind: Schema.Literal('editTask'),
    stamp: Stamp,
    time: WallTime,
    title: Title,
  }),
  Schema.Struct({ index: Index, kind: Schema.Literal('toggleTask'), stamp: Stamp }),
  Schema.Struct({ index: Index, kind: Schema.Literal('deleteTask') }),
  Schema.Struct({
    dismissReminders: Schema.Boolean,
    dismissTasks: Schema.Boolean,
    dismissWhenOver: Schema.Boolean,
    events: Schema.Boolean,
    includeAppleReminders: Schema.Boolean,
    kind: Schema.Literal('settings'),
    tasks: Schema.Boolean,
    time: WallTime,
  }),
  /** The app open: a short wait between passes. */
  Schema.Struct({
    kind: Schema.Literal('wait'),
    minutes: Schema.Int.check(Schema.isBetween({ maximum: 120, minimum: 1 })),
  }),
  /** The Mac asleep or the app closed: no pass until it wakes. */
  Schema.Struct({
    kind: Schema.Literal('sleep'),
    minutes: Schema.Int.check(Schema.isBetween({ maximum: 2000, minimum: 120 })),
  }),
  Schema.Struct({ kind: Schema.Literal('travel'), zone: AnyZone }),
]);
type Command = typeof Command.Type;
type AddEvent = Extract<Command, { readonly kind: 'addEvent' }>;
type AddTask = Extract<Command, { readonly kind: 'addTask' }>;
/** The fixed script's own steps: wake at an instant, add on a date it computed. */
type Step =
  | Command
  | { readonly at: number; readonly kind: 'wakeAt' }
  | (AddEvent & { readonly on: string })
  | (AddTask & { readonly on: string });

const Setup = Schema.Struct({
  /** Which of its two transitions the generated commands start before. */
  direction: Schema.Literals(['back', 'forward']),
  home: HomeZone,
  /** Hours from the start to that transition: a sleep or two crosses it. */
  lead: Schema.Int.check(Schema.isBetween({ maximum: 60, minimum: 1 })),
});
type Setup = typeof Setup.Type;

// ---------------------------------------------------------------------------
// The model: what the user asked for, and the rows it becomes.

interface ModelEvent {
  readonly allDay: boolean;
  readonly date: string;
  readonly id: string;
  readonly length: number;
  readonly reminders: 'default' | ReadonlyArray<number>;
  readonly repeat: boolean;
  readonly time: string;
  readonly title: string;
  readonly updatedAt: number;
}

interface ModelTask {
  readonly apple: boolean;
  /** The stored due day. */
  readonly date: string;
  /** A reminder's instant of its own. */
  readonly dueUtc: number | undefined;
  readonly id: string;
  readonly open: boolean;
  /** A reminder's due time, floating or the instant's reading where it was written. */
  readonly time: string | undefined;
  readonly title: string;
  readonly updatedAt: number;
}

interface ModelSettings {
  readonly dismissReminders: boolean;
  readonly dismissTasks: boolean;
  readonly dismissWhenOver: boolean;
  readonly events: boolean;
  readonly includeAppleReminders: boolean;
  readonly tasks: boolean;
  readonly time: string;
}

interface Model {
  deviceZone: string;
  readonly events: Map<string, ModelEvent>;
  /** The first pass that planned tasks: their `since` while no setting was saved. */
  firstTaskPass: number | undefined;
  readonly home: string;
  /** The previous pass: what came due after it is due now. */
  lastPass: number | undefined;
  serial: number;
  settings: ModelSettings;
  /** When the settings were last saved. */
  settingsAt: number | undefined;
  readonly tasks: Map<string, ModelTask>;
}

const DEFAULT_SETTINGS: ModelSettings = {
  dismissReminders: true,
  dismissTasks: true,
  dismissWhenOver: true,
  events: true,
  includeAppleReminders: true,
  tasks: true,
  time: '09:00',
};

const popup = (minutes: number) => new ReminderOverride({ method: 'popup', minutes });

const eventRecord = (event: ModelEvent, home: string): EventRecord => {
  const startUtc = event.allDay ? utcDay(event.date) : zonedInstant(event.date, event.time, home);
  return new EventRecord({
    accountId: ACCOUNT,
    calendarId: CALENDAR,
    endDate: event.allDay ? addDays(event.date, 1) : undefined,
    endUtc: startUtc + (event.allDay ? DAY : event.length * MINUTE),
    etag: null,
    id: event.id,
    isAllDay: event.allDay,
    recurrence: event.repeat ? [`RRULE:FREQ=DAILY;COUNT=${String(SERIES_COUNT)}`] : undefined,
    reminders:
      event.reminders === 'default'
        ? new EventReminders({ overrides: [], useDefault: true })
        : new EventReminders({ overrides: event.reminders.map(popup), useDefault: false }),
    startDate: event.allDay ? event.date : undefined,
    startTimeZone: home,
    startUtc,
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: event.title,
    updatedAt: event.updatedAt,
  });
};

const taskRecord = (task: ModelTask): TaskRecord =>
  new TaskRecord({
    accountId: task.apple ? APPLE_REMINDERS_ACCOUNT_ID : ACCOUNT,
    completedAt: task.open ? undefined : task.updatedAt,
    dueDate: task.date,
    dueTime: task.time,
    dueUtc: task.dueUtc,
    id: task.id,
    listId: task.apple ? APPLE_LIST : GOOGLE_LIST,
    provider: task.apple ? 'apple' : 'google',
    status: task.open ? 'needsAction' : 'completed',
    title: task.title,
    updatedAt: task.updatedAt,
  });

// ---------------------------------------------------------------------------
// The oracle: every notification the current intent asks for at `now`.

interface Expected {
  readonly dismissAt: number | undefined;
  readonly expiresAt: number;
  readonly fireAt: number;
  readonly key: string;
  /** Since when its subject (row and setting) has been as it is now. */
  readonly since: number;
  readonly title: string;
}

interface Occurrence {
  /** When a delivered reminder is over: the end, an all-day one's at midnight on the device. */
  readonly endRef: number;
  /** The stored range, for whether a read of the window holds it. */
  readonly endUtc: number;
  readonly id: string;
  /** What the offsets count back from: the start, an all-day one's local midnight. */
  readonly startRef: number;
  readonly startUtc: number;
}

/** Whether `zone`'s clock reads `time` on `date` at all: a transition forward skips some. */
const wallExists = (date: string, time: string, zone: string): boolean =>
  localTime(zonedInstant(date, time, zone), zone) === time;

const occurrencesOf = (event: ModelEvent, model: Model): Array<Occurrence> => {
  // A series repeats the wall time its first start reads: a start in a
  // skipped hour stored the later reading, which every day then keeps.
  const time = localTime(zonedInstant(event.date, event.time, model.home), model.home);
  const out: Array<Occurrence> = [];
  // A later day whose clock skips that time has no occurrence and does not
  // count toward COUNT (RFC 5545 §3.3.10); a repeated time is the earlier.
  for (let day = 0; out.length < (event.repeat ? SERIES_COUNT : 1); day += 1) {
    const date = addDays(event.date, day);
    if (!event.allDay && day > 0 && !wallExists(date, time, model.home)) {
      continue;
    }
    const startUtc = event.allDay ? utcDay(date) : zonedInstant(date, time, model.home);
    const endUtc = startUtc + (event.allDay ? DAY : event.length * MINUTE);
    out.push({
      endRef: event.allDay ? startOfDay(addDays(date, 1), model.deviceZone) : endUtc,
      endUtc,
      id: event.repeat ? `${event.id}__${String(startUtc)}` : event.id,
      startRef: event.allDay ? startOfDay(date, model.home) : startUtc,
      startUtc,
    });
  }
  return out;
};

const eventPlans = (model: Model, now: number): Array<Expected> => {
  if (!model.settings.events) {
    return [];
  }
  const from = now - EVENT_LOOKBACK_MS;
  const until = now + HORIZON_MS;
  const out: Array<Expected> = [];
  for (const event of model.events.values()) {
    const minutes =
      event.reminders === 'default' ? [DEFAULT_MINUTES] : [...new Set(event.reminders)];
    for (const occurrence of occurrencesOf(event, model)) {
      if (
        occurrence.startUtc >= until + MAX_REMINDER_MINUTES * MINUTE ||
        occurrence.endUtc <= from
      ) {
        continue;
      }
      const expiresAt = occurrence.startRef + (event.allDay ? 12 * HOUR : 5 * MINUTE);
      for (const offset of minutes) {
        const fireAt = occurrence.startRef - offset * MINUTE;
        if (fireAt >= from && fireAt < until) {
          out.push({
            dismissAt: Math.max(occurrence.endRef, expiresAt),
            expiresAt,
            fireAt,
            key: `event:${ACCOUNT}/${CALENDAR}/${occurrence.id}:${String(occurrence.startUtc)}:${String(offset)}`,
            // The row alone (#272): only task plans date from the settings save too.
            since: event.updatedAt,
            title: event.title,
          });
        }
      }
    }
  }
  return out;
};

const taskPlans = (model: Model, now: number): Array<Expected> => {
  if (!model.settings.tasks) {
    return [];
  }
  const today = localDate(now, model.deviceZone);
  const last = addDays(today, TASK_HORIZON_DAYS);
  const configured = model.settingsAt ?? model.firstTaskPass ?? now;
  const out: Array<Expected> = [];
  for (const task of model.tasks.values()) {
    if (!task.open || (task.apple && !model.settings.includeAppleReminders)) {
      continue;
    }
    const date = task.dueUtc === undefined ? task.date : localDate(task.dueUtc, model.deviceZone);
    if (date < today || date > last) {
      continue;
    }
    const accountId = task.apple ? APPLE_REMINDERS_ACCOUNT_ID : ACCOUNT;
    out.push({
      dismissAt: undefined,
      expiresAt: startOfDay(addDays(date, 1), model.deviceZone),
      fireAt: task.dueUtc ?? zonedInstant(date, task.time ?? model.settings.time, model.deviceZone),
      key:
        task.dueUtc === undefined
          ? `task:${accountId}/${task.id}:${date}`
          : `task:${accountId}/${task.id}@${String(task.dueUtc)}`,
      since: Math.max(task.updatedAt, configured),
      title: task.title,
    });
  }
  return out;
};

const byDelivery = (
  a: { readonly fireAt: number; readonly key: string },
  b: { readonly fireAt: number; readonly key: string },
) => a.fireAt - b.fireAt || a.key.localeCompare(b.key);

const plansAt = (model: Model, now: number): Array<Expected> => {
  const plans = [...eventPlans(model, now), ...taskPlans(model, now)].sort(byDelivery);
  // The model never asks for two notifications under one key.
  expect(new Set(plans.map((plan) => plan.key)).size).toBe(plans.length);
  return plans;
};

const projected = (
  plans: ReadonlyArray<{
    readonly dismissAt?: number | undefined;
    readonly fireAt: number;
    readonly key: string;
    readonly title: string;
  }>,
) =>
  [...plans]
    .sort(byDelivery)
    .map(({ dismissAt, fireAt, key, title }) => ({ dismissAt, fireAt, key, title }));

/**
 * Whether a delivered notification should leave this pass, as iOS's
 * switches promise: an event reminder once its event is over, a task's
 * once the task is done, on another day, or gone for a minute.
 */
const leavesNow = (
  model: Model,
  delivered: DeliveredNotification,
  now: number,
  missing: { readonly next: Map<string, number>; readonly previous: Map<string, number> },
): boolean => {
  const { target } = delivered;
  if (target?.kind !== 'task') {
    return (
      model.settings.dismissWhenOver &&
      delivered.dismissAt !== undefined &&
      delivered.dismissAt <= now
    );
  }
  const apple = target.accountId === APPLE_REMINDERS_ACCOUNT_ID;
  if (!(apple ? model.settings.dismissReminders : model.settings.dismissTasks)) {
    return false;
  }
  const task = model.tasks.get(target.taskId);
  if (!task) {
    const since = missing.previous.get(delivered.key) ?? now;
    if (now - since < ABSENT_GRACE_MS) {
      missing.next.set(delivered.key, since);
      return false;
    }
    return true;
  }
  return (
    !task.open ||
    (target.dueUtc === undefined ? task.date !== target.dueDate : task.dueUtc !== target.dueUtc)
  );
};

// ---------------------------------------------------------------------------
// The platforms: what the OS was handed, delivered and still shows.

const makeImmediateSink = () => {
  const shown: Array<PlannedNotification> = [];
  const sink: NotificationSinkShape = {
    ensurePermission: () => Effect.succeed(true),
    kind: 'immediate',
    show: (plan) => Effect.sync(() => void shown.push(plan)),
  };
  return { shown, sink };
};

const makeScheduledSink = () => {
  const os = {
    dismissed: [] as Array<string>,
    /** Every delivery, for the record of what the run reached. */
    everDelivered: [] as Array<PlannedNotification>,
    pending: [] as Array<PlannedNotification>,
    presented: new Map<string, DeliveredNotification>(),
  };
  /** Time passes: iOS delivers each pending notification at its moment, apart from the app. */
  const deliverUntil = (now: number) => {
    for (const plan of os.pending.filter((pending) => pending.fireAt <= now)) {
      os.presented.set(plan.key, { dismissAt: plan.dismissAt, key: plan.key, target: plan.target });
      os.everDelivered.push(plan);
    }
    os.pending = os.pending.filter((pending) => pending.fireAt > now);
  };
  const sink: NotificationSinkShape = {
    dismissDelivered: (shouldDismiss) =>
      Effect.gen(function* () {
        // Deleting the entry being visited leaves a Map's iteration intact.
        for (const delivered of os.presented.values()) {
          if (yield* shouldDismiss(delivered)) {
            os.presented.delete(delivered.key);
            os.dismissed.push(delivered.key);
          }
        }
      }),
    ensurePermission: () => Effect.succeed(true),
    kind: 'scheduled',
    replaceSchedule: (plans) =>
      Effect.sync(() => {
        os.pending = [...plans];
      }),
  };
  return { deliverUntil, os, sink };
};

const layerFor = (sink: NotificationSinkShape, model: Model) =>
  LocalNotifications.layer({ timeZone: () => model.deviceZone }).pipe(
    Layer.provideMerge(appleCalendarServicesLayer(unavailableAppleCalendarClient('property test'))),
    Layer.provideMerge(DeviceContacts.layer),
    Layer.provideMerge(
      Layer.succeed(ContactsClient, makeFakeContactsClient({ birthdays: [] }).client),
    ),
    Layer.provideMerge(Layer.succeed(NotificationSink, sink)),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
  );

const seed = (home: string) =>
  Effect.gen(function* () {
    const accounts = yield* AccountRepo;
    yield* accounts.upsert(
      new Account({
        contactsEnabled: false,
        createdAt: 1,
        email: 'property@example.com',
        id: ACCOUNT,
        provider: 'google',
        status: 'ok',
        tasksEnabled: true,
      }),
    );
    yield* accounts.upsert(
      new Account({
        contactsEnabled: false,
        createdAt: 1,
        email: '',
        id: APPLE_REMINDERS_ACCOUNT_ID,
        provider: 'apple',
        status: 'ok',
        tasksEnabled: true,
      }),
    );
    yield* (yield* CalendarRepo).upsertMany([
      new CalendarInfo({
        accessRole: 'owner',
        accountId: ACCOUNT,
        colorHex: '#3b82f6',
        defaultReminders: [popup(DEFAULT_MINUTES)],
        id: CALENDAR,
        isPrimary: true,
        isVisible: true,
        provider: 'google',
        summary: 'Property',
        timeZone: home,
      }),
    ]);
    yield* (yield* TaskRepo).upsertLists(
      [
        new TaskListInfo({
          accountId: ACCOUNT,
          id: GOOGLE_LIST,
          isVisible: true,
          provider: 'google',
          title: 'Inbox',
        }),
        new TaskListInfo({
          accountId: APPLE_REMINDERS_ACCOUNT_ID,
          id: APPLE_LIST,
          isVisible: true,
          provider: 'apple',
          title: 'Errands',
        }),
      ],
      1,
    );
  });

// ---------------------------------------------------------------------------
// The scenario.

type SinkKind = 'immediate' | 'scheduled';

const pick = <A>(map: Map<string, A>, index: number): A | undefined => {
  const values = [...map.values()];
  return values.length === 0 ? undefined : values[index % values.length];
};

const stampOf = (stamp: 'earlier' | 'now', now: number, previous = 0): number =>
  stamp === 'now' ? now : Math.max(previous, now - EARLIER_MS);

const applyEventCommand = (
  model: Model,
  command: Extract<Step, { readonly kind: 'addEvent' | 'deleteEvent' | 'editEvent' }>,
  now: number,
) =>
  Effect.gen(function* () {
    const repo = yield* EventRepo;
    const today = localDate(now, model.home);
    if (command.kind === 'addEvent') {
      model.serial += 1;
      const event: ModelEvent = {
        allDay: command.allDay,
        date: 'on' in command ? command.on : addDays(today, command.day),
        id: `event-${String(model.serial)}`,
        length: command.length,
        reminders: command.reminders,
        repeat: command.repeat,
        time: command.time,
        title: command.title,
        updatedAt: stampOf(command.stamp, now),
      };
      model.events.set(event.id, event);
      yield* repo.upsertMany([eventRecord(event, model.home)]);
      return;
    }
    const event = pick(model.events, command.index);
    if (!event) {
      return;
    }
    if (command.kind === 'deleteEvent') {
      model.events.delete(event.id);
      yield* repo.deleteEvent(ACCOUNT, CALENDAR, event.id);
      return;
    }
    const edited: ModelEvent = {
      ...event,
      date: addDays(today, command.day),
      reminders: command.reminders,
      time: command.time,
      title: `${command.title} ${String(now)}`,
      updatedAt: stampOf(command.stamp, now, event.updatedAt),
    };
    model.events.set(event.id, edited);
    yield* repo.upsertMany([eventRecord(edited, model.home)]);
  });

const applyTaskCommand = (
  model: Model,
  command: Extract<Step, { readonly kind: 'addTask' | 'deleteTask' | 'editTask' | 'toggleTask' }>,
  now: number,
) =>
  Effect.gen(function* () {
    const repo = yield* TaskRepo;
    const today = localDate(now, model.deviceZone);
    if (command.kind === 'addTask') {
      model.serial += 1;
      const date = 'on' in command ? command.on : addDays(today, command.day);
      const timed = command.timing === 'floating' || command.timing === 'zoned';
      const task: ModelTask = {
        apple: command.timing !== 'google',
        date,
        dueUtc:
          command.timing === 'zoned'
            ? zonedInstant(date, command.time, model.deviceZone)
            : undefined,
        id: `task-${String(model.serial)}`,
        open: true,
        time: timed ? command.time : undefined,
        title: command.title,
        updatedAt: stampOf(command.stamp, now),
      };
      model.tasks.set(task.id, task);
      yield* repo.upsertTasks([taskRecord(task)], now);
      return;
    }
    const task = pick(model.tasks, command.index);
    if (!task) {
      return;
    }
    if (command.kind === 'deleteTask') {
      model.tasks.delete(task.id);
      yield* repo.removeTask(
        task.apple ? APPLE_REMINDERS_ACCOUNT_ID : ACCOUNT,
        task.apple ? APPLE_LIST : GOOGLE_LIST,
        task.id,
      );
      return;
    }
    const updatedAt = stampOf(command.stamp, now, task.updatedAt);
    const edited: ModelTask =
      command.kind === 'toggleTask'
        ? { ...task, open: !task.open, updatedAt }
        : {
            ...task,
            date: addDays(today, command.day),
            dueUtc:
              task.dueUtc === undefined
                ? undefined
                : zonedInstant(addDays(today, command.day), command.time, model.deviceZone),
            time: task.time === undefined ? undefined : command.time,
            title: `${command.title} ${String(now)}`,
            updatedAt,
          };
    model.tasks.set(task.id, edited);
    yield* repo.upsertTasks([taskRecord(edited)], now);
  });

const applySettings = (model: Model, command: Extract<Command, { readonly kind: 'settings' }>) =>
  Effect.gen(function* () {
    model.settings = {
      dismissReminders: command.dismissReminders,
      dismissTasks: command.dismissTasks,
      dismissWhenOver: command.dismissWhenOver,
      events: command.events,
      includeAppleReminders: command.includeAppleReminders,
      tasks: command.tasks,
      time: command.time,
    };
    model.settingsAt = yield* Clock.currentTimeMillis;
    yield* writeEventNotificationSettings({
      dismissWhenOver: command.dismissWhenOver,
      enabled: command.events,
      includeAppleCalendar: false,
    });
    yield* writeTaskNotificationSettings({
      dismissRemindersWhenDone: command.dismissReminders,
      dismissTasksWhenDone: command.dismissTasks,
      enabled: command.tasks,
      includeAppleReminders: command.includeAppleReminders,
      time: command.time,
    });
  });

/** What a run reached, so a short or shrunk tail cannot pass by doing nothing. */
interface Reached {
  readonly caughtUp: Array<number>;
  readonly delivered: Array<number>;
  readonly dismissedEvents: Array<string>;
  readonly dismissedTasks: Array<string>;
}

const scenario = (kind: SinkKind, setup: Setup, commands: ReadonlyArray<Command>) => {
  const transition = transitionAfter(
    setup.home,
    setup.direction,
    Date.parse('2026-01-01T00:00:00Z'),
  );
  const start = transition - setup.lead * HOUR;
  const model: Model = {
    deviceZone: setup.home,
    events: new Map(),
    firstTaskPass: undefined,
    home: setup.home,
    lastPass: undefined,
    serial: 0,
    settings: DEFAULT_SETTINGS,
    settingsAt: undefined,
    tasks: new Map(),
  };
  const immediate = makeImmediateSink();
  const scheduled = makeScheduledSink();
  const sink = kind === 'immediate' ? immediate.sink : scheduled.sink;
  const lastShown = new Map<string, number>();
  let missing = new Map<string, number>();
  const reached: Reached = { caughtUp: [], delivered: [], dismissedEvents: [], dismissedTasks: [] };

  const checkImmediate = (
    now: number,
    previous: number,
    shown: ReadonlyArray<PlannedNotification>,
  ) => {
    // Shown: what came due since the last pass, or whose subject was
    // already so before its moment, while it is still worth showing —
    // once per key and moment, again only at a later moment.
    const expected = plansAt(model, now).filter(
      (plan) =>
        plan.fireAt <= now &&
        now < plan.expiresAt &&
        (plan.fireAt > previous || plan.since < plan.fireAt) &&
        (lastShown.get(plan.key) ?? Number.NEGATIVE_INFINITY) < plan.fireAt,
    );
    expect(projected(shown.map((plan) => ({ ...plan, dismissAt: undefined })))).toEqual(
      projected(expected.map((plan) => ({ ...plan, dismissAt: undefined }))),
    );
    for (const plan of shown) {
      lastShown.set(plan.key, plan.fireAt);
      if (plan.fireAt <= previous) {
        reached.caughtUp.push(plan.fireAt);
      }
      reached.delivered.push(plan.fireAt);
    }
  };

  const checkScheduled = (
    now: number,
    presentedBefore: ReadonlyArray<DeliveredNotification>,
    dismissed: ReadonlyArray<string>,
  ) => {
    // Pending: exactly what is still ahead, the soonest first, in the slots there are.
    const ahead = plansAt(model, now)
      .filter((plan) => plan.fireAt > now)
      .slice(0, SCHEDULE_SLOTS);
    expect(projected(scheduled.os.pending)).toEqual(projected(ahead));
    expect(new Set(scheduled.os.pending.map((plan) => plan.key)).size).toBe(
      scheduled.os.pending.length,
    );
    // Delivered: each leaves exactly when its switch says it no longer holds.
    const next = new Map<string, number>();
    const shouldLeave = presentedBefore
      .filter((delivered) => leavesNow(model, delivered, now, { next, previous: missing }))
      .map((delivered) => delivered.key);
    missing = next;
    expect([...dismissed].sort()).toEqual(shouldLeave.sort());
    for (const key of dismissed) {
      (key.startsWith('task:') ? reached.dismissedTasks : reached.dismissedEvents).push(key);
    }
  };

  const advanceTo = (at: number) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(at);
      scheduled.deliverUntil(at);
    });

  const apply = (step: Step) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      switch (step.kind) {
        case 'addEvent':
        case 'deleteEvent':
        case 'editEvent':
          return yield* applyEventCommand(model, step, now);
        case 'addTask':
        case 'deleteTask':
        case 'editTask':
        case 'toggleTask':
          return yield* applyTaskCommand(model, step, now);
        case 'settings':
          return yield* applySettings(model, step);
        case 'sleep':
        case 'wait':
          return yield* advanceTo(now + step.minutes * MINUTE);
        case 'travel':
          model.deviceZone = step.zone;
          return;
        case 'wakeAt':
          return yield* advanceTo(Math.max(now, step.at));
      }
    });

  const pass = Effect.gen(function* () {
    const notifications = yield* LocalNotifications;
    const now = yield* Clock.currentTimeMillis;
    const previous = model.lastPass ?? now;
    const shownBefore = immediate.shown.length;
    const dismissedBefore = scheduled.os.dismissed.length;
    const presentedBefore = [...scheduled.os.presented.values()];
    yield* notifications.run();
    if (model.firstTaskPass === undefined && model.settings.tasks) {
      model.firstTaskPass = now;
    }
    if (kind === 'immediate') {
      checkImmediate(now, previous, immediate.shown.slice(shownBefore));
    } else {
      checkScheduled(now, presentedBefore, scheduled.os.dismissed.slice(dismissedBefore));
    }
    model.lastPass = now;
  });

  const startDate = localDate(start, setup.home);
  const transitionDate = localDate(transition, setup.home);
  // The generated commands start among these, within hours of the transition.
  const prefix: ReadonlyArray<Step> = [
    {
      dismissReminders: true,
      dismissTasks: true,
      dismissWhenOver: true,
      events: true,
      includeAppleReminders: true,
      kind: 'settings',
      tasks: true,
      time: '02:30',
    },
    {
      allDay: false,
      day: 0,
      kind: 'addEvent',
      length: 30,
      reminders: [10, 60],
      repeat: true,
      stamp: 'now',
      time: '02:30',
      title: 'Standup',
    },
    { day: 1, kind: 'addTask', stamp: 'now', time: '09:00', timing: 'google', title: 'Rent' },
    { day: 2, kind: 'addTask', stamp: 'now', time: '02:30', timing: 'zoned', title: 'Flight' },
    {
      allDay: true,
      day: 1,
      kind: 'addEvent',
      length: 0,
      reminders: [0, 900],
      repeat: false,
      stamp: 'now',
      time: '09:00',
      title: 'Dentist',
    },
    {
      day: daysFrom(startDate, transitionDate),
      kind: 'addTask',
      stamp: 'now',
      time: '09:00',
      timing: 'floating',
      title: 'Rent',
    },
  ];

  /**
   * After the generated commands, a fixed script around the zone's other
   * transition: a notification on each side of it, one at 09:00 on the
   * day itself, a catch-up of a row pulled past its moment, both edges of
   * that day's expiry (23 or 25 hours long), a delivered event and task
   * leaving, and a trip that puts a reminder's instant on another day.
   */
  const script = (now: number): ReadonlyArray<Step> => {
    const home = setup.home;
    const other = transitionAfter(home, setup.direction === 'back' ? 'forward' : 'back', now);
    // The day the transition makes 23 or 25 hours long: its date, or for a
    // transition at midnight (Santiago) possibly the day before.
    const day = [localDate(other - HOUR, home), localDate(other + HOUR, home)].find(
      (date) => startOfDay(addDays(date, 1), home) - startOfDay(date, home) !== DAY,
    )!;
    const on = (offset: number) => addDays(day, offset);
    const meeting = {
      allDay: false,
      kind: 'addEvent',
      length: 30,
      repeat: false,
      stamp: 'now',
      time: '09:00',
      title: 'Standup',
    } as const;
    const task = { day: 0, stamp: 'now', time: '09:00', title: 'Rent' } as const;
    const westward = home === 'Australia/Sydney';
    const trip = {
      ...task,
      kind: 'addTask',
      on: on(2),
      time: westward ? '00:30' : '23:30',
      timing: 'zoned',
    } as const;
    return [
      { kind: 'travel', zone: home },
      { at: zonedInstant(on(-2), '12:00', home), kind: 'wakeAt' },
      {
        dismissReminders: true,
        dismissTasks: true,
        dismissWhenOver: true,
        events: true,
        includeAppleReminders: true,
        kind: 'settings',
        tasks: true,
        time: '09:00',
      },
      { ...meeting, day: 0, on: on(-1), reminders: [60] },
      { ...meeting, day: 0, on: on(1), reminders: [60, 1440] },
      // Renamed, nothing else: iOS must be handed the new title.
      {
        day: 3,
        index: model.events.size + 1,
        kind: 'editEvent',
        reminders: [60, 1440],
        stamp: 'now',
        time: '09:00',
        title: 'Dentist',
      },
      { ...task, kind: 'addTask', on: day, timing: 'floating' },
      { ...task, kind: 'addTask', on: day, timing: 'google' },
      { at: zonedInstant(on(-1), '08:01', home), kind: 'wakeAt' },
      { at: zonedInstant(on(-1), '09:31', home), kind: 'wakeAt' },
      { at: zonedInstant(day, '23:30', home), kind: 'wakeAt' },
      // The floating reminder above: the first task this script adds.
      { index: model.tasks.size, kind: 'toggleTask', stamp: 'now' },
      // Pulled at 23:30 with its 18:00 reminder already past: a catch-up.
      { ...meeting, day: 0, on: on(1), reminders: [900], stamp: 'earlier', title: 'Flight' },
      { at: zonedInstant(on(1), '00:30', home), kind: 'wakeAt' },
      { ...task, kind: 'addTask', on: day, stamp: 'earlier', timing: 'google' },
      { at: zonedInstant(on(1), '08:01', home), kind: 'wakeAt' },
      trip,
      { kind: 'travel', zone: westward ? 'Europe/Vienna' : 'Australia/Sydney' },
      { at: zonedInstant(trip.on, trip.time, home) + 12 * HOUR, kind: 'wakeAt' },
    ];
  };

  return Effect.gen(function* () {
    yield* TestClock.setTime(start);
    yield* seed(setup.home);
    yield* pass;
    for (const step of [...prefix, ...commands]) {
      yield* apply(step);
      yield* pass;
    }
    const scriptStart = yield* Clock.currentTimeMillis;
    const steps = script(scriptStart);
    const other = transitionAfter(
      setup.home,
      setup.direction === 'back' ? 'forward' : 'back',
      scriptStart,
    );
    for (const step of steps) {
      yield* apply(step);
      yield* pass;
    }
    const delivered = (
      kind === 'immediate'
        ? reached.delivered
        : scheduled.os.everDelivered.map((plan) => plan.fireAt)
    ).filter((fireAt) => fireAt > scriptStart);
    expect(
      delivered.some((fireAt) => fireAt < other),
      'a notification before the transition',
    ).toBe(true);
    expect(
      delivered.some((fireAt) => fireAt > other),
      'a notification after the transition',
    ).toBe(true);
    if (kind === 'immediate') {
      expect(
        reached.caughtUp.some((fireAt) => fireAt > scriptStart),
        'a catch-up',
      ).toBe(true);
    } else {
      expect(reached.dismissedEvents.length).toBeGreaterThan(0);
      expect(reached.dismissedTasks.length).toBeGreaterThan(0);
    }
  }).pipe(Effect.provide(layerFor(sink, model)), Effect.scoped);
};

const replay = process.env['NOTIFICATION_PROPERTY_REPLAY'];

it.effect.prop(
  'Desktop shows each due notification once, on time or caught up, never a stale or a past-born one',
  { commands: Schema.Array(Command).check(Schema.isBetweenLength(1, 30)), setup: Setup },
  ({ commands, setup }) => scenario('immediate', setup, commands),
  {
    arbitrary: { ...(replay ? { replay } : {}), runs: 40, size: 30 },
    timeout: 60_000,
  },
);

it.effect.prop(
  'iOS keeps exactly the current intent scheduled and clears delivered ones as their switches say',
  { commands: Schema.Array(Command).check(Schema.isBetweenLength(1, 30)), setup: Setup },
  ({ commands, setup }) => scenario('scheduled', setup, commands),
  {
    arbitrary: { ...(replay ? { replay } : {}), runs: 40, size: 30 },
    timeout: 60_000,
  },
);
