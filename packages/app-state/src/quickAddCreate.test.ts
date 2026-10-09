import { describe, expect, it } from 'vite-plus/test';
import { eventDraftFromPrefill, taskParamsFromPrefill } from './quickAddCreate.ts';

const calendar = { accountId: 'acc', calendarId: 'cal' };

describe('eventDraftFromPrefill', () => {
  it('builds a timed draft in the zone, with the location and the rule', () => {
    const draft = eventDraftFromPrefill(
      {
        date: '2026-10-03',
        endTime: '14:00',
        isAllDay: false,
        location: 'Café Sperl',
        recurrence: { count: 3, freq: 'weekly' },
        startTime: '13:00',
        title: 'Lunch with Sarah',
      },
      calendar,
      'Europe/Vienna',
    );
    expect(draft).toMatchObject({
      accountId: 'acc',
      calendarId: 'cal',
      isAllDay: false,
      location: 'Café Sperl',
      startTimeZone: 'Europe/Vienna',
      startUtc: Date.parse('2026-10-03T13:00:00+02:00'),
      title: 'Lunch with Sarah',
    });
    expect(draft.endUtc - draft.startUtc).toBe(3_600_000);
    expect(draft.recurrence?.[0]).toMatch(/^RRULE:FREQ=WEEKLY/);
    expect(draft.recurrence?.[0]).toContain('COUNT=3');
  });

  it('builds an all-day draft on its dates', () => {
    const draft = eventDraftFromPrefill(
      { date: '2026-10-03', endTime: '01:00', isAllDay: true, startTime: '00:00', title: 'Trip' },
      calendar,
      'Europe/Vienna',
    );
    expect(draft).toMatchObject({ endDate: '2026-10-04', isAllDay: true, startDate: '2026-10-03' });
    expect(draft.location).toBeUndefined();
    expect(draft.recurrence).toBeUndefined();
  });
});

describe('taskParamsFromPrefill', () => {
  it('keeps the time for a Reminders list only', () => {
    const prefill = { date: '2026-10-03', time: '09:30', title: 'Call the bank' };
    expect(taskParamsFromPrefill(prefill, { accountId: 'a', id: 'l', provider: 'apple' })).toEqual({
      accountId: 'a',
      dueDate: '2026-10-03',
      dueTime: '09:30',
      taskListId: 'l',
      title: 'Call the bank',
    });
    expect(
      taskParamsFromPrefill(prefill, { accountId: 'g', id: 'tasks', provider: 'google' }).dueTime,
    ).toBeUndefined();
  });
});
