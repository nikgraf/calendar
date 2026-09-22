import type { PlannedNotification } from '@calendar/core';
import {
  type AccountRepo,
  type BirthdayRepo,
  type CalendarRepo,
  DeviceSettingsRepo,
  type EventRepo,
} from '@calendar/db';
import { BIRTHDAYS_KEY, EVENTS_KEY } from '@calendar/db/keys';
import { Clock, Context, Duration, Effect, Layer, Semaphore, Stream } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import type { AppleCalendarEvents } from './appleCalendarEvents.ts';
import { loadBirthdayPlans } from './birthdayReminders.ts';
import type { DeviceContacts } from './deviceContacts.ts';
import { loadEventPlans } from './eventReminders.ts';
import { NotificationSink } from './notificationSink.ts';

/** Fired keys are remembered this long — past every producer's catch-up window plus slack. */
const FIRED_TTL_MS = 48 * 60 * 60 * 1000;
/** iOS keeps at most 64 pending local notifications; leave room for others. */
const MAX_SCHEDULED = 60;
/** The loop sleeps until the next delivery, within these bounds. */
const MIN_WAIT_MS = 5000;
const MAX_WAIT_MS = 60_000;
/** A sync pass or an edit repaints events in bursts; one pass per burst. */
const CHANGE_DEBOUNCE = '2 seconds';

/** Bookkeeping rows in device_settings, keyed apart from the user's settings. */
const FIRED_KEY = 'localNotifications.fired';
const SCHEDULED_KEY = 'localNotifications.scheduled';
/** The birthday-only scheduler's fired map, read once so an upgrade re-fires nothing. */
const LEGACY_FIRED_KEY = 'birthdayReminders.fired';

export interface LocalNotificationsShape {
  /** One pass: deliver what is due (desktop) or refresh the OS schedule (iOS). Never fails. */
  readonly run: () => Effect.Effect<void>;
  /** The periodic loop plus the change-triggered reruns, detached in the scope. */
  readonly start: () => Effect.Effect<void>;
}

const firedRecord = (raw: unknown): Record<string, number> =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? Object.fromEntries(
        Object.entries(raw as Record<string, unknown>).filter(
          (entry): entry is [string, number] => typeof entry[1] === 'number',
        ),
      )
    : {};

/** One merged plan across producers, sorted by delivery; keys are unique per producer. */
const merge = (
  ...lists: ReadonlyArray<ReadonlyArray<PlannedNotification>>
): ReadonlyArray<PlannedNotification> =>
  lists.flat().sort((a, b) => a.fireAt - b.fireAt || a.key.localeCompare(b.key));

/**
 * Turns settings + birthdays + events into local notifications. Its own
 * loop, not part of the sync pass: the engine stays free of a
 * notification dependency, and settings changes trigger a run directly.
 * "The notification is latency, the pass is correctness" applies: a
 * fired reminder is best-effort, every run recomputes from the stored
 * state. Producers return nothing when their setting is off; the OS
 * schedule is only cleared when every producer does.
 */
const make = (options: {
  readonly timeZone: string;
}): Effect.Effect<
  LocalNotificationsShape,
  never,
  | AccountRepo
  | AppleCalendarEvents
  | BirthdayRepo
  | CalendarRepo
  | DeviceContacts
  | DeviceSettingsRepo
  | EventRepo
  | NotificationSink
  | Reactivity
> =>
  Effect.gen(function* () {
    const settingsRepo = yield* DeviceSettingsRepo;
    const sink = yield* NotificationSink;
    const reactivity = yield* Reactivity;
    // One pass at a time: the loop, a settings save, a change and a
    // foreground return all call run(), and a disabling pass must not be
    // overtaken by an enabled one still handing the OS its schedule.
    const gate = Semaphore.makeUnsafe(1);
    // The pass's own requirements, captured once so `run` is self-contained.
    const context = yield* Effect.context<
      | AccountRepo
      | AppleCalendarEvents
      | BirthdayRepo
      | CalendarRepo
      | DeviceContacts
      | DeviceSettingsRepo
      | EventRepo
    >();

    const loadFired = Effect.gen(function* () {
      const current = yield* settingsRepo.get(FIRED_KEY);
      if (current !== null) {
        return firedRecord(current);
      }
      // First run after the upgrade: the old map used unprefixed birthday keys.
      return Object.fromEntries(
        Object.entries(firedRecord(yield* settingsRepo.get(LEGACY_FIRED_KEY))).map(
          ([key, firedAt]) => [`birthday:${key}`, firedAt],
        ),
      );
    });

    /** Shows what is due and returns the next delivery still ahead. */
    const deliverImmediate = (plans: ReadonlyArray<PlannedNotification>, now: number) =>
      Effect.gen(function* () {
        if (sink.kind !== 'immediate') {
          return undefined;
        }
        const previous = yield* loadFired;
        const fired = Object.fromEntries(
          Object.entries(previous).filter(([, firedAt]) => firedAt >= now - FIRED_TTL_MS),
        );
        // A missed notification fires only while its producer still finds
        // it worth showing (a birthday all day, a meeting until it starts).
        const due = plans.filter(
          (plan) => plan.fireAt <= now && now < plan.expiresAt && !(plan.key in fired),
        );
        for (const plan of due) {
          yield* sink.show(plan);
          fired[plan.key] = plan.fireAt;
        }
        if (due.length > 0 || Object.keys(fired).length !== Object.keys(previous).length) {
          yield* settingsRepo.set(FIRED_KEY, fired);
        }
        return plans.find((plan) => plan.fireAt > now)?.fireAt;
      });

    const refreshSchedule = (plans: ReadonlyArray<PlannedNotification>, now: number) =>
      Effect.gen(function* () {
        if (sink.kind !== 'scheduled') {
          return;
        }
        // The soonest across producers win the slots.
        const future = plans.filter((plan) => plan.fireAt > now).slice(0, MAX_SCHEDULED);
        // Time and copy are part of the digest: a new delivery time or a
        // renamed contact changes what the OS should show, not which key.
        const digest = future
          .map((plan) => `${plan.key}@${String(plan.fireAt)}:${plan.title}:${plan.body}`)
          .join('|');
        if ((yield* settingsRepo.get(SCHEDULED_KEY)) === digest) {
          return;
        }
        if (future.length > 0 && !(yield* sink.ensurePermission())) {
          yield* Effect.logWarning('local notifications: permission not granted');
          return;
        }
        yield* sink.replaceSchedule(future);
        yield* settingsRepo.set(SCHEDULED_KEY, digest);
      });

    const pass = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const plans = merge(
        yield* loadBirthdayPlans(now, options.timeZone),
        yield* loadEventPlans(now, options.timeZone),
      );
      const next = yield* deliverImmediate(plans, now);
      yield* refreshSchedule(plans, now);
      return next;
    });

    const runNext = (): Effect.Effect<number | undefined> =>
      gate
        .withPermits(1)(pass)
        .pipe(
          Effect.provide(context),
          Effect.catchCause((cause) =>
            Effect.as(
              Effect.logWarning('local notifications pass failed', { cause: String(cause) }),
              undefined,
            ),
          ),
        );

    const run = (): Effect.Effect<void> => Effect.asVoid(runNext());

    // Sleep until the next delivery: a "10 minutes before" reminder should
    // not arrive a minute late, and an idle calendar need not spin.
    const loop = Effect.forever(
      Effect.gen(function* () {
        const next = yield* runNext();
        const now = yield* Clock.currentTimeMillis;
        const wait =
          next === undefined
            ? MAX_WAIT_MS
            : Math.min(MAX_WAIT_MS, Math.max(MIN_WAIT_MS, next - now));
        yield* Effect.sleep(Duration.millis(wait));
      }),
    );

    // An edit, a sync pass or a contact change re-plans right away (debounced).
    const onChange = reactivity.stream([BIRTHDAYS_KEY, EVENTS_KEY], Effect.void).pipe(
      Stream.drop(1),
      Stream.debounce(CHANGE_DEBOUNCE),
      Stream.runForEach(() => run()),
    );

    const start = (): Effect.Effect<void> =>
      Effect.asVoid(Effect.all([Effect.forkDetach(loop), Effect.forkDetach(onChange)]));

    return { run, start };
  });

export class LocalNotifications extends Context.Service<
  LocalNotifications,
  LocalNotificationsShape
>()('sync/LocalNotifications') {
  static readonly layer = (options: {
    readonly timeZone: string;
  }): Layer.Layer<
    LocalNotifications,
    never,
    | AccountRepo
    | AppleCalendarEvents
    | BirthdayRepo
    | CalendarRepo
    | DeviceContacts
    | DeviceSettingsRepo
    | EventRepo
    | NotificationSink
    | Reactivity
  > => Layer.effect(LocalNotifications)(make(options));
}
