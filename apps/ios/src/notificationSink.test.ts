import type { PlannedNotification } from '@calendar/core';
import { Effect, Exit } from 'effect';
import type { NotificationRequestInput, SchedulableTriggerInputTypes } from 'expo-notifications';
import { describe, expect, it } from 'vite-plus/test';
import {
  makeIosNotificationSink,
  type NotificationsModule,
  type PresentedNotification,
} from './notificationSink.ts';

const presented = (identifier: string, data?: Record<string, unknown>): PresentedNotification => ({
  request: { content: data === undefined ? {} : { data }, identifier },
});

const fakeNotifications = (
  options: { presented?: ReadonlyArray<PresentedNotification>; presentedFails?: boolean } = {},
) => {
  const dismissed: Array<string> = [];
  const scheduled: Array<NotificationRequestInput> = [];
  let cancelled = 0;
  const module: NotificationsModule = {
    cancelAllScheduledNotificationsAsync: () => {
      cancelled += 1;
      return Promise.resolve();
    },
    dismissNotificationAsync: (identifier) => {
      dismissed.push(identifier);
      return Promise.resolve();
    },
    getPermissionsAsync: () => Promise.resolve({ canAskAgain: true, granted: true }),
    getPresentedNotificationsAsync: () =>
      options.presentedFails
        ? Promise.reject(new Error('no presenter'))
        : Promise.resolve(options.presented ?? []),
    requestPermissionsAsync: () => Promise.resolve({ granted: true }),
    SchedulableTriggerInputTypes: { DATE: 'date' as SchedulableTriggerInputTypes.DATE },
    scheduleNotificationAsync: (request) => {
      scheduled.push(request);
      return Promise.resolve(request.identifier ?? '');
    },
    setNotificationHandler: () => undefined,
  };
  return { cancelled: () => cancelled, dismissed, module, scheduled };
};

/** The sink under test, narrowed to the scheduled kind it always is. */
const scheduledSink = (module: NotificationsModule) => {
  const sink = makeIosNotificationSink(module);
  if (sink.kind !== 'scheduled') {
    throw new Error('the iOS sink is scheduled');
  }
  return sink;
};

const start = Date.parse('2026-03-04T09:00:00Z');
const target = {
  accountId: 'acc',
  calendarId: 'cal',
  eventId: 'ev',
  kind: 'event' as const,
  startUtc: start,
};
const meeting: PlannedNotification = {
  body: 'In 10 minutes · 9:00 AM',
  dismissAt: Date.parse('2026-03-04T10:00:00Z'),
  expiresAt: start + 5 * 60_000,
  fireAt: start - 10 * 60_000,
  key: `event:acc/cal/ev:${String(start)}:10`,
  target,
  title: 'Standup',
};
const birthday: PlannedNotification = {
  body: 'Turns 32 today',
  expiresAt: Date.parse('2026-03-05T00:00:00Z'),
  fireAt: Date.parse('2026-03-04T08:00:00Z'),
  key: 'birthday:a:2026-03-04:0',
  title: '🎂 Alice',
};

describe('makeIosNotificationSink', () => {
  it('schedules each plan under its key with the dismissal and the target in the payload', async () => {
    const fake = fakeNotifications();
    await Effect.runPromise(scheduledSink(fake.module).replaceSchedule([meeting, birthday]));
    expect(fake.cancelled()).toBe(1);
    expect(fake.scheduled.map((request) => [request.identifier, request.content.data])).toEqual([
      [meeting.key, { dismissAt: meeting.dismissAt, target }],
      [birthday.key, {}],
    ]);
    expect(fake.scheduled[0]!.trigger).toEqual({ date: new Date(meeting.fireAt), type: 'date' });
  });

  it('dismisses the delivered notifications whose moment has passed, no other', async () => {
    const fake = fakeNotifications({
      presented: [
        presented('over', { dismissAt: 1000, target }),
        presented('ending-now', { dismissAt: 2000 }),
        presented('ongoing', { dismissAt: 2001 }),
        presented('birthday'),
        presented('odd-payload', { dismissAt: '1000' }),
      ],
    });
    await Effect.runPromise(scheduledSink(fake.module).dismissDelivered(2000));
    expect(fake.dismissed).toEqual(['over', 'ending-now']);
  });

  it('fails when the OS will not list delivered notifications, so the scheduler can log it', async () => {
    const fake = fakeNotifications({ presentedFails: true });
    const exit = await Effect.runPromise(
      Effect.exit(scheduledSink(fake.module).dismissDelivered(0)),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(fake.dismissed).toEqual([]);
  });
});
