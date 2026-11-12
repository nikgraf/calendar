import { describe, expect, it } from 'vite-plus/test';
import type { QuickAddItem } from './quickAddItem.ts';
import { type TurnLimits, turnRefusal } from './threadRefusal.ts';

const standup: QuickAddItem = {
  kind: 'event',
  prefill: {
    date: '2026-08-28',
    endTime: '09:15',
    isAllDay: false,
    startTime: '09:00',
    title: 'Standup',
  },
};
const with_ = (prefill: Record<string, unknown>): QuickAddItem =>
  ({ kind: 'event', prefill: { ...standup.prefill, ...prefill } }) as QuickAddItem;
const weekly = with_({ recurrence: { freq: 'weekly' } });
const opened = { date: '2026-08-28', endDate: '2026-08-28', isAllDay: false };

const single: TurnLimits = { canInvite: true, repeatEditable: false };
const series = (scope: 'following' | 'instance' | 'series'): TurnLimits => ({
  canInvite: true,
  repeatEditable: true,
  series: { opened, scope },
});

describe('turnRefusal', () => {
  it('takes what a stored event can hold', () => {
    expect(
      turnRefusal(standup, with_({ endTime: '10:15', startTime: '10:00' }), true, single),
    ).toBeUndefined();
    expect(turnRefusal(standup, with_({ title: 'Daily' }), false, single)).toBeUndefined();
  });

  it('refuses a rule on a single stored event, which an update cannot give it', () => {
    expect(turnRefusal(standup, weekly, false, single)).toBe(
      'How this event repeats can’t be changed here.',
    );
    // A series whose rule the app does not hold (read through from Apple) is the same.
    expect(
      turnRefusal(standup, weekly, false, {
        canInvite: false,
        repeatEditable: false,
        series: { opened, scope: 'series' },
      }),
    ).toBe('How this event repeats can’t be changed here.');
  });

  it('refuses a changed rule at "This event", and takes it at a scope that can hold one', () => {
    const daily = with_({ recurrence: { freq: 'daily' } });
    expect(turnRefusal(weekly, daily, false, series('instance'))).toBe(
      'Choose “All events” or “This and following” to change how it repeats.',
    );
    expect(turnRefusal(weekly, daily, false, series('series'))).toBeUndefined();
    expect(turnRefusal(weekly, daily, false, series('following'))).toBeUndefined();
  });

  it('takes a turn that leaves the rule as it is, however it was written', () => {
    const rewritten = with_({
      recurrence: { byDay: [], freq: 'weekly', interval: 1 },
      title: 'Daily',
    });
    expect(turnRefusal(weekly, rewritten, false, series('instance'))).toBeUndefined();
    // "Thursday instead" on one occurrence moves that occurrence.
    expect(
      turnRefusal(
        weekly,
        with_({ date: '2026-08-27', recurrence: { freq: 'weekly' } }),
        false,
        series('instance'),
      ),
    ).toBeUndefined();
  });

  it('refuses what a series’ times may not change to', () => {
    expect(
      turnRefusal(
        weekly,
        with_({ isAllDay: true, recurrence: { freq: 'weekly' } }),
        false,
        series('instance'),
      ),
    ).toBe('A repeating event cannot switch between all-day and timed.');
    const allDay = { ...opened, isAllDay: true };
    const moved = with_({ date: '2026-08-29', isAllDay: true, recurrence: { freq: 'weekly' } });
    expect(
      turnRefusal(weekly, moved, false, {
        canInvite: true,
        repeatEditable: true,
        series: { opened: allDay, scope: 'series' },
      }),
    ).toBe('An all-day repeating event moves one occurrence at a time: choose “This event”.');
    expect(
      turnRefusal(weekly, moved, false, {
        canInvite: true,
        repeatEditable: true,
        series: { opened: allDay, scope: 'instance' },
      }),
    ).toBeUndefined();
  });

  it('refuses guests where the calendar holds none, and only a turn that invites', () => {
    const apple: TurnLimits = { canInvite: false, repeatEditable: false };
    expect(turnRefusal(standup, standup, true, apple)).toBe('This calendar can’t add guests here.');
    expect(turnRefusal(standup, with_({ title: 'Daily' }), false, apple)).toBeUndefined();
  });

  it('takes a to-do as it is: a series’ rules are an event’s', () => {
    const call: QuickAddItem = { kind: 'task', prefill: { date: '2026-08-28', title: 'Call' } };
    expect(
      turnRefusal(call, { ...call, prefill: { ...call.prefill, time: '09:00' } }, false, single),
    ).toBeUndefined();
  });
});
