import { describe, expect, it } from 'vitest';
import {
  APPLE_CALENDAR_ACCOUNT_ID,
  CalendarInfo,
  EventRecord,
  EventReminders,
  ReminderOverride,
} from '../types.ts';
import {
  canonicalReminders,
  effectivePopupMinutes,
  planEventReminders,
  reminderLabel,
} from './eventReminders.ts';

const utc = (iso: string): number => Date.parse(iso);

const popup = (minutes: number) => new ReminderOverride({ method: 'popup', minutes });
const email = (minutes: number) => new ReminderOverride({ method: 'email', minutes });

const calendar = (overrides: Partial<CalendarInfo> = {}): CalendarInfo =>
  new CalendarInfo({
    accessRole: 'owner',
    accountId: 'acc',
    colorHex: '#000000',
    defaultReminders: [popup(10), email(30)],
    id: 'cal',
    isPrimary: true,
    isVisible: true,
    provider: 'google',
    summary: 'Work',
    timeZone: 'Europe/Vienna',
    ...overrides,
  });

const event = (overrides: Partial<EventRecord> = {}): EventRecord =>
  new EventRecord({
    accountId: 'acc',
    calendarId: 'cal',
    endUtc: utc('2026-03-04T10:00:00Z'),
    etag: null,
    id: 'ev',
    isAllDay: false,
    startTimeZone: 'Europe/Vienna',
    startUtc: utc('2026-03-04T09:00:00Z'),
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: 'Standup',
    updatedAt: 0,
    ...overrides,
  });

const window = {
  calendars: [calendar()],
  deviceTimeZone: 'UTC',
  from: utc('2026-03-01T00:00:00Z'),
  includeApple: false,
  until: utc('2026-03-08T00:00:00Z'),
};

describe('reminderLabel', () => {
  it('names timed offsets in the largest whole unit', () => {
    expect([0, 5, 60, 90, 1440, 10_080].map((m) => reminderLabel(m, false))).toEqual([
      'At time of event',
      '5 minutes before',
      '1 hour before',
      '90 minutes before',
      '1 day before',
      '1 week before',
    ]);
  });

  it('names all-day offsets from midnight, with the clock time of a partial day', () => {
    expect([0, 420, 900, 1440, 1860, 10_080].map((m) => reminderLabel(m, true))).toEqual([
      'At midnight',
      'The day before at 5:00 PM',
      'The day before at 9:00 AM',
      '1 day before',
      '2 days before at 5:00 PM',
      '7 days before',
    ]);
  });
});

describe('canonicalReminders', () => {
  it('drops invalid offsets, dedupes, sorts by method then offset and caps at five', () => {
    const result = canonicalReminders(
      new EventReminders({
        overrides: [popup(30), popup(10.4), email(5), popup(10), popup(-1), popup(99_999)],
        useDefault: false,
      }),
    );
    expect(result.overrides.map((o) => [o.method, o.minutes])).toEqual([
      ['email', 5],
      ['popup', 10],
      ['popup', 30],
    ]);
    const many = canonicalReminders(
      new EventReminders({ overrides: [1, 2, 3, 4, 5, 6].map(popup), useDefault: true }),
    );
    expect(many.overrides).toHaveLength(5);
    expect(many.useDefault).toBe(true);
  });
});

describe('effectivePopupMinutes', () => {
  it('resolves defaults, overrides and the not-yet-modelled case per provider', () => {
    const cal = calendar();
    expect(effectivePopupMinutes(event(), cal)).toEqual([10]);
    expect(
      effectivePopupMinutes(
        event({ reminders: new EventReminders({ overrides: [popup(5)], useDefault: true }) }),
        cal,
      ),
    ).toEqual([10]);
    expect(
      effectivePopupMinutes(
        event({
          reminders: new EventReminders({ overrides: [popup(30), email(5)], useDefault: false }),
        }),
        cal,
      ),
    ).toEqual([30]);
    expect(
      effectivePopupMinutes(
        event({ reminders: new EventReminders({ overrides: [], useDefault: false }) }),
        cal,
      ),
    ).toEqual([]);
    expect(
      effectivePopupMinutes(event({ accountId: APPLE_CALENDAR_ACCOUNT_ID }), undefined),
    ).toEqual([]);
  });
});

describe('planEventReminders', () => {
  it('plans popup offsets before a timed start with the event as copy, sorted by delivery', () => {
    const plans = planEventReminders(
      [
        event({
          location: 'Room 4B',
          reminders: new EventReminders({ overrides: [popup(30), popup(0)], useDefault: false }),
        }),
      ],
      window,
    );
    const start = utc('2026-03-04T09:00:00Z');
    expect(plans.map((plan) => [plan.key, plan.fireAt, plan.body, plan.expiresAt])).toEqual([
      [
        `event:acc/cal/ev:${String(start)}:30`,
        start - 30 * 60_000,
        'In 30 minutes · 10:00 AM · Room 4B',
        start + 5 * 60_000,
      ],
      [
        `event:acc/cal/ev:${String(start)}:0`,
        start,
        'Starting now · 10:00 AM · Room 4B',
        start + 5 * 60_000,
      ],
    ]);
    expect(plans[0]!.title).toBe('Standup');
  });

  it('names the day when the delivery falls on an earlier one', () => {
    const plans = planEventReminders(
      [
        event({
          reminders: new EventReminders({
            overrides: [popup(30), popup(1440), popup(2880)],
            useDefault: false,
          }),
          startUtc: utc('2026-03-04T00:15:00Z'),
        }),
      ],
      window,
    );
    expect(plans.map((plan) => plan.body)).toEqual([
      'In 2 days · Wed, Mar 4 1:15 AM',
      'In 1 day · Tomorrow 1:15 AM',
      'In 30 minutes · 1:15 AM',
    ]);
  });

  it('uses the calendar defaults for an event that defers to them', () => {
    const plans = planEventReminders([event()], window);
    expect(plans.map((plan) => plan.fireAt)).toEqual([utc('2026-03-04T08:50:00Z')]);
  });

  it('counts all-day offsets from local midnight in the calendar zone', () => {
    const plans = planEventReminders(
      [
        event({
          endDate: '2026-03-05',
          isAllDay: true,
          reminders: new EventReminders({ overrides: [popup(900), popup(0)], useDefault: false }),
          startDate: '2026-03-04',
          startTimeZone: undefined,
          startUtc: utc('2026-03-04T00:00:00Z'),
        }),
      ],
      window,
    );
    // Vienna is UTC+1 in March: midnight local = 23:00Z the day before.
    expect(plans.map((plan) => [plan.fireAt, plan.body])).toEqual([
      [utc('2026-03-03T08:00:00Z'), 'All day tomorrow'],
      [utc('2026-03-03T23:00:00Z'), 'All day today'],
    ]);
    expect(plans[1]!.expiresAt).toBe(utc('2026-03-04T11:00:00Z'));
  });

  it('skips cancelled and declined events and keeps delivery inside the window', () => {
    const declined = event({
      attendees: [{ email: 'me@x.com', isSelf: true, responseStatus: 'declined' }],
      id: 'declined',
    });
    const cancelled = event({ id: 'cancelled', status: 'cancelled' });
    const late = event({
      endUtc: utc('2026-03-09T10:00:00Z'),
      id: 'late',
      startUtc: utc('2026-03-09T09:00:00Z'),
    });
    const early = event({
      endUtc: utc('2026-03-01T10:00:00Z'),
      id: 'early',
      reminders: new EventReminders({ overrides: [popup(1440)], useDefault: false }),
      startUtc: utc('2026-03-01T09:00:00Z'),
    });
    expect(planEventReminders([declined, cancelled, late, early], window)).toEqual([]);
  });

  it('includes Apple Calendar events only when asked, in the device zone', () => {
    const apple = event({
      accountId: APPLE_CALENDAR_ACCOUNT_ID,
      calendarId: 'ek',
      reminders: new EventReminders({ overrides: [popup(15)], useDefault: false }),
    });
    expect(planEventReminders([apple], window)).toEqual([]);
    const plans = planEventReminders([apple], { ...window, includeApple: true });
    expect(plans.map((plan) => [plan.fireAt, plan.body])).toEqual([
      [utc('2026-03-04T08:45:00Z'), 'In 15 minutes · 9:00 AM'],
    ]);
  });
});
