import {
  dismissesWhenDone,
  dismissesWhenOver,
  isAppleRemindersAccount,
  type PlannedNotification,
} from '@calendar/core';
import {
  type AccountRepo,
  type BirthdayRepo,
  type CalendarRepo,
  DeviceSettingsRepo,
  type EventRepo,
  PendingOpRepo,
  TaskRepo,
} from '@calendar/db';
import { BIRTHDAYS_KEY, EVENTS_KEY, TASKLISTS_KEY, TASKS_KEY } from '@calendar/db/keys';
import { Clock, Context, Duration, Effect, Layer, Semaphore, Stream } from 'effect';
import { Reactivity } from 'effect/reactivity/Reactivity';
import type { AppleCalendarEvents } from './appleCalendarEvents.ts';
import { loadBirthdayPlans } from './birthdayReminders.ts';
import type { DeviceContacts } from './deviceContacts.ts';
import {
  readBirthdayReminderSettings,
  readEventNotificationSettings,
  readTaskNotificationSettings,
} from './deviceSettings.ts';
import { loadEventPlans } from './eventReminders.ts';
import { NotificationSink } from './notificationSink.ts';
import { loadTaskPlans } from './taskReminders.ts';

/** Fired keys are remembered this long — past every producer's catch-up window plus slack. */
const FIRED_TTL_MS = 48 * 60 * 60 * 1000;
/** iOS keeps at most 64 pending local notifications; leave room for others. */
const MAX_SCHEDULED = 60;
/** The loop sleeps until the next delivery, within these bounds. */
const MIN_WAIT_MS = 5000;
const MAX_WAIT_MS = 60_000;
/** A sync pass or an edit repaints events in bursts; one pass per burst. */
const CHANGE_DEBOUNCE = '2 seconds';
/**
 * A delivered task notification whose row is missing waits this long
 * before it counts as deleted: a move made on another device reaches this
 * one list by list, the source's row leaving one pull before the
 * destination's arrives, and the change-triggered pass lands in between.
 */
const ABSENT_GRACE_MS = 60_000;

/** Bookkeeping rows in device_settings, keyed apart from the user's settings. */
const FIRED_KEY = 'localNotifications.fired';
const SCHEDULED_KEY = 'localNotifications.scheduled';
/** When an immediate sink last ran a pass: what came due since is what it shows. */
const LAST_PASS_KEY = 'localNotifications.lastPass';
/** Delivered task notifications whose row is missing, and since when (see ABSENT_GRACE_MS). */
const ABSENT_KEY = 'localNotifications.absent';
/** Set once an immediate sink has been asked for permission (first start). */
const PERMISSION_ASKED_KEY = 'localNotifications.permissionAsked';

export interface LocalNotificationsShape {
  /**
   * One pass: deliver what is due (desktop), or refresh the OS schedule and
   * clear delivered reminders past their `dismissAt` (iOS). Never fails.
   */
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

/**
 * One merged plan across producers, sorted by delivery, one per key: the
 * keys are unique per producer, except that a task moved between lists
 * can be stored twice for a pull or two (the copy and its original), and
 * a desktop would show both.
 */
const merge = (
  ...lists: ReadonlyArray<ReadonlyArray<PlannedNotification>>
): ReadonlyArray<PlannedNotification> => {
  const keys = new Set<string>();
  const out: Array<PlannedNotification> = [];
  for (const plan of lists
    .flat()
    .sort((a, b) => a.fireAt - b.fireAt || a.key.localeCompare(b.key))) {
    if (!keys.has(plan.key)) {
      keys.add(plan.key);
      out.push(plan);
    }
  }
  return out;
};

/**
 * Turns settings + birthdays + events + tasks into local notifications.
 * Its own loop, not part of the sync pass: the engine stays free of a
 * notification dependency, and settings changes trigger a run directly.
 * "The notification is latency, the pass is correctness" applies: a
 * fired reminder is best-effort, every run recomputes from the stored
 * state. Producers return nothing when their setting is off; the OS
 * schedule is only cleared when every producer does.
 */
const make = (options: {
  /**
   * The device's zone, read on every pass: notifications follow the
   * device (docs/decisions.md, "Multiple time zones"), and a phone that
   * travelled keeps its process — captured once at startup, birthday
   * 9:00s and reminder times stayed on the zone it left.
   */
  readonly timeZone: () => string;
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
  | PendingOpRepo
  | Reactivity
  | TaskRepo
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
      | PendingOpRepo
      | TaskRepo
    >();

    const loadFired = Effect.map(settingsRepo.get(FIRED_KEY), firedRecord);

    /**
     * An immediate sink cannot ask for permission on its own (macOS
     * prompts on the first banner), and event notifications are on by
     * default — so the first pass asks, rather than the first due
     * reminder weeks later. Once only: the key is set before the ask so
     * a crash mid-prompt never turns into a nag on every launch.
     */
    const askOnce = Effect.gen(function* () {
      if (sink.kind !== 'immediate' || (yield* settingsRepo.get(PERMISSION_ASKED_KEY)) === true) {
        return;
      }
      const events = yield* readEventNotificationSettings;
      const birthdays = yield* readBirthdayReminderSettings;
      const tasks = yield* readTaskNotificationSettings;
      if (!events.enabled && !birthdays.enabled && !tasks.enabled) {
        return;
      }
      yield* settingsRepo.set(PERMISSION_ASKED_KEY, true);
      if (!(yield* sink.ensurePermission())) {
        yield* Effect.logWarning('local notifications: permission not granted at first start');
      }
    });

    /** Shows what came due since the last pass and returns the next delivery still ahead. */
    const deliverImmediate = (plans: ReadonlyArray<PlannedNotification>, now: number) =>
      Effect.gen(function* () {
        if (sink.kind !== 'immediate') {
          return undefined;
        }
        const previous = yield* loadFired;
        const fired = Object.fromEntries(
          Object.entries(previous).filter(([, firedAt]) => firedAt >= now - FIRED_TTL_MS),
        );
        // What came due since the last pass, or whose subject its row or
        // setting dates from before the moment (`since`: the pull that
        // brought the row landed after a pass, the Mac opened after its
        // sleep), while its producer still finds it worth showing (a
        // birthday all day, a meeting until it starts, a task until its day
        // ends). A plan whose moment was already past when its subject came
        // to be — a task created in the afternoon, a notify time moved
        // earlier, a setting switched on — stays silent, as on iOS, which
        // schedules nothing past. The first pass of this record counts as
        // the last one: a profile from before it has nothing to catch up on
        // that the old build did not show. A key fires again at a later
        // moment (a reminder postponed), as iOS re-delivers it.
        const lastPass = yield* settingsRepo.get(LAST_PASS_KEY);
        const since = typeof lastPass === 'number' ? lastPass : now;
        const due = plans.filter((plan) => {
          const firedAt = fired[plan.key];
          return (
            (plan.fireAt > since || (plan.since !== undefined && plan.since < plan.fireAt)) &&
            plan.fireAt <= now &&
            now < plan.expiresAt &&
            (firedAt === undefined || firedAt < plan.fireAt)
          );
        });
        for (const plan of due) {
          yield* sink.show(plan);
          fired[plan.key] = plan.fireAt;
        }
        if (due.length > 0 || Object.keys(fired).length !== Object.keys(previous).length) {
          yield* settingsRepo.set(FIRED_KEY, fired);
        }
        yield* settingsRepo.set(LAST_PASS_KEY, now);
        return plans.find((plan) => plan.fireAt > now)?.fireAt;
      });

    const refreshSchedule = (plans: ReadonlyArray<PlannedNotification>, now: number) =>
      Effect.gen(function* () {
        if (sink.kind !== 'scheduled') {
          return;
        }
        // The soonest across producers win the slots.
        const future = plans.filter((plan) => plan.fireAt > now).slice(0, MAX_SCHEDULED);
        // Time, copy and the dismissal are part of the digest: a new delivery
        // time, a renamed contact or a later end changes what the OS should
        // show or keep, not which key.
        const digest = future
          .map(
            (plan) =>
              `${plan.key}@${String(plan.fireAt)}:${plan.dismissAt === undefined ? '' : String(plan.dismissAt)}:${plan.title}:${plan.body}`,
          )
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

    /**
     * Delivered notifications whose moment has passed leave Notification
     * Center — on every pass, digest or not: the OS keeps the delivered
     * list, and the scheduler says which to drop. An event reminder once
     * its payload's `dismissAt` passed, unless "Remove When Over" is off;
     * a task's once the stored task is done, re-dated or gone for a
     * minute (ABSENT_GRACE_MS), unless that
     * provider's "Remove When Done" is off. The payloads keep their data,
     * so a switch turned back on clears them on the next pass. Remembered
     * here: only which rows went missing, and when. Best-effort: a failure
     * is logged, the next pass tries again.
     */
    const dismissDelivered = (
      now: number,
    ): Effect.Effect<void, never, DeviceSettingsRepo | TaskRepo> =>
      sink.kind !== 'scheduled'
        ? Effect.void
        : Effect.gen(function* () {
            const overEvents = dismissesWhenOver(yield* readEventNotificationSettings);
            const tasks = yield* readTaskNotificationSettings;
            const taskRepo = yield* TaskRepo;
            // Stored, so a background pass counts toward the grace too.
            const absentBefore = firedRecord(yield* settingsRepo.get(ABSENT_KEY));
            const absent: Record<string, number> = {};
            yield* sink.dismissDelivered((delivered) =>
              Effect.gen(function* () {
                const { target } = delivered;
                if (target?.kind === 'task') {
                  const provider = isAppleRemindersAccount({ id: target.accountId })
                    ? 'apple'
                    : 'google';
                  if (!dismissesWhenDone(tasks, provider)) {
                    return false;
                  }
                  // The list first, then the id alone: a move keeps it. A task
                  // on another day than the notification's — a reminder with
                  // an instant of its own, at another instant — is done with
                  // that day (a repeating reminder checked off advances in
                  // place under its id) or re-dated; either way the
                  // notification no longer holds.
                  const task =
                    (yield* taskRepo.get(target.accountId, target.listId, target.taskId)) ??
                    (yield* taskRepo.findById(target.accountId, target.taskId));
                  if (!task) {
                    const missingSince = absentBefore[delivered.key] ?? now;
                    if (now - missingSince < ABSENT_GRACE_MS) {
                      absent[delivered.key] = missingSince;
                      return false;
                    }
                    return true;
                  }
                  return (
                    task.status === 'completed' ||
                    (target.dueUtc === undefined
                      ? task.dueDate !== target.dueDate
                      : task.dueUtc !== target.dueUtc)
                  );
                }
                return (
                  overEvents && delivered.dismissAt !== undefined && delivered.dismissAt <= now
                );
              }),
            );
            if (JSON.stringify(absent) !== JSON.stringify(absentBefore)) {
              yield* settingsRepo.set(ABSENT_KEY, absent);
            }
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning('local notifications: dismiss failed', { cause: String(cause) }),
            ),
          );

    const planAndHandOver = (now: number) =>
      Effect.gen(function* () {
        const timeZone = options.timeZone();
        const plans = merge(
          yield* loadBirthdayPlans(now, timeZone),
          yield* loadEventPlans(now, timeZone),
          yield* loadTaskPlans(now, timeZone),
        );
        const next = yield* deliverImmediate(plans, now);
        yield* refreshSchedule(plans, now);
        return next;
      });

    const pass = Effect.gen(function* () {
      yield* askOnce;
      const now = yield* Clock.currentTimeMillis;
      // After the hand-over, so a slow dismissal never delays it — and
      // whatever became of it: a schedule the OS refused, or plans that
      // could not be read, must not keep a finished event on screen.
      const outcome = yield* Effect.exit(planAndHandOver(now));
      yield* dismissDelivered(now);
      return yield* outcome;
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

    // An edit, a sync pass, a contact change or a task checked off re-plans
    // right away (debounced); a list shown or hidden too.
    const onChange = reactivity
      .stream([BIRTHDAYS_KEY, EVENTS_KEY, TASKLISTS_KEY, TASKS_KEY], Effect.void)
      .pipe(
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
    /** The device's zone, read on every pass (see `make`). */
    readonly timeZone: () => string;
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
    | PendingOpRepo
    | Reactivity
    | TaskRepo
  > => Layer.effect(LocalNotifications)(make(options));
}
