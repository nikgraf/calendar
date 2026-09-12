import { planBirthdayReminders, type PlannedNotification, Temporal } from '@calendar/core';
import { type AccountRepo, type BirthdayRepo, DeviceSettingsRepo } from '@calendar/db';
import { Clock, Context, Effect, Layer, Schedule } from 'effect';
import { loadMergedBirthdays } from './birthdays.ts';
import type { DeviceContacts } from './deviceContacts.ts';
import { readBirthdayReminderSettings } from './deviceSettings.ts';
import { NotificationSink } from './notificationSink.ts';

/** How far ahead notifications are planned (iOS schedules from this list). */
const HORIZON_DAYS = 120;
/** Immediate sinks fire a missed notification for this long after its time, then let it go. */
const CATCH_UP_MS = 24 * 60 * 60 * 1000;
/** Fired keys are remembered this long — past the catch-up window plus slack. */
const FIRED_TTL_MS = 48 * 60 * 60 * 1000;
/** iOS keeps at most 64 pending local notifications; leave room for others. */
const MAX_SCHEDULED = 60;
const RUN_INTERVAL = '60 seconds';

/** Bookkeeping rows in device_settings, keyed apart from the user's settings. */
const FIRED_KEY = 'birthdayReminders.fired';
const SCHEDULED_KEY = 'birthdayReminders.scheduled';

export interface BirthdayRemindersShape {
  /** One pass: deliver what is due (desktop) or refresh the OS schedule (iOS). Never fails. */
  readonly run: () => Effect.Effect<void>;
  /** The periodic loop, detached in the scope. */
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
 * Turns settings + birthdays into notifications. Its own loop, not part
 * of the sync pass: the engine stays free of a notification dependency,
 * and settings changes trigger a run directly. "The notification is
 * latency, the pass is correctness" applies: a fired reminder is
 * best-effort, every run recomputes from the stored state.
 */
const make = (options: {
  readonly timeZone: string;
}): Effect.Effect<
  BirthdayRemindersShape,
  never,
  AccountRepo | BirthdayRepo | DeviceContacts | DeviceSettingsRepo | NotificationSink
> =>
  Effect.gen(function* () {
    const settingsRepo = yield* DeviceSettingsRepo;
    const sink = yield* NotificationSink;
    // The pass's own requirements, captured once so `run` is self-contained.
    const context = yield* Effect.context<
      AccountRepo | BirthdayRepo | DeviceContacts | DeviceSettingsRepo
    >();

    const deliverImmediate = (plans: ReadonlyArray<PlannedNotification>, now: number) =>
      Effect.gen(function* () {
        if (sink.kind !== 'immediate') {
          return;
        }
        const previous = firedRecord(yield* settingsRepo.get(FIRED_KEY));
        const fired = Object.fromEntries(
          Object.entries(previous).filter(([, firedAt]) => firedAt >= now - FIRED_TTL_MS),
        );
        const due = plans.filter(
          (plan) => plan.fireAt <= now && plan.fireAt >= now - CATCH_UP_MS && !(plan.key in fired),
        );
        for (const plan of due) {
          yield* sink.show(plan);
          fired[plan.key] = plan.fireAt;
        }
        if (due.length > 0 || Object.keys(fired).length !== Object.keys(previous).length) {
          yield* settingsRepo.set(FIRED_KEY, fired);
        }
      });

    const refreshSchedule = (plans: ReadonlyArray<PlannedNotification>, now: number) =>
      Effect.gen(function* () {
        if (sink.kind !== 'scheduled') {
          return;
        }
        const future = plans.filter((plan) => plan.fireAt > now).slice(0, MAX_SCHEDULED);
        const digest = future.map((plan) => plan.key).join('|');
        if ((yield* settingsRepo.get(SCHEDULED_KEY)) === digest) {
          return;
        }
        if (future.length > 0 && !(yield* sink.ensurePermission())) {
          yield* Effect.logWarning('birthday reminders: notification permission not granted');
          return;
        }
        yield* sink.replaceSchedule(future);
        yield* settingsRepo.set(SCHEDULED_KEY, digest);
      });

    const pass = Effect.gen(function* () {
      const settings = yield* readBirthdayReminderSettings;
      const now = yield* Clock.currentTimeMillis;
      if (!settings.enabled) {
        // Nothing to deliver; a scheduled sink drops what it had, once.
        yield* refreshSchedule([], now);
        return;
      }
      const records = yield* loadMergedBirthdays;
      // From yesterday: an immediate sink catches up on last night's
      // reminders, which the planner would otherwise drop as past.
      const fromDate = Temporal.Instant.fromEpochMilliseconds(now)
        .toZonedDateTimeISO(options.timeZone)
        .toPlainDate()
        .subtract({ days: 1 })
        .toString();
      const plans = planBirthdayReminders(records, settings, {
        fromDate,
        horizonDays: HORIZON_DAYS,
        timeZone: options.timeZone,
      });
      yield* deliverImmediate(plans, now);
      yield* refreshSchedule(plans, now);
    });

    const run = (): Effect.Effect<void> =>
      pass.pipe(
        Effect.provide(context),
        Effect.catchCause((cause) =>
          Effect.logWarning('birthday reminders pass failed', { cause: String(cause) }),
        ),
      );

    const start = (): Effect.Effect<void> =>
      Effect.asVoid(Effect.forkDetach(Effect.repeat(run(), Schedule.spaced(RUN_INTERVAL))));

    return { run, start };
  });

export class BirthdayReminders extends Context.Service<BirthdayReminders, BirthdayRemindersShape>()(
  'sync/BirthdayReminders',
) {
  static readonly layer = (options: {
    readonly timeZone: string;
  }): Layer.Layer<
    BirthdayReminders,
    never,
    AccountRepo | BirthdayRepo | DeviceContacts | DeviceSettingsRepo | NotificationSink
  > => Layer.effect(BirthdayReminders)(make(options));
}
