import { CalendarInfo } from '@calendar/core';
import { describe, expect, it } from 'vitest';
import { editorCapabilities, recurringTimesError, repeatScopeError } from './editorModel.ts';

const calendar = (provider: 'apple' | 'google', accessRole: CalendarInfo['accessRole'] = 'owner') =>
  new CalendarInfo({
    accessRole,
    accountId: provider === 'apple' ? 'apple-calendar' : 'acc-1',
    colorHex: '#1badf8',
    id: `${provider}-${accessRole}`,
    isPrimary: false,
    isVisible: true,
    provider,
    summary: 'x',
    timeZone: 'UTC',
  });

const base = {
  hasOwnAttendee: false,
  isExisting: true,
  isRecurring: false,
  scope: 'instance' as const,
  sourceCalendar: calendar('google'),
  targetCalendar: calendar('google'),
};

describe('editorCapabilities', () => {
  it('offers guests only where the picked calendar can invite', () => {
    expect(editorCapabilities(base).canInvite).toBe(true);
    expect(editorCapabilities({ ...base, targetCalendar: calendar('apple') }).canInvite).toBe(
      false,
    );
  });

  it('offers "calendar default" reminders only on Google calendars', () => {
    expect(editorCapabilities(base).canUseDefaultReminders).toBe(true);
    expect(
      editorCapabilities({ ...base, targetCalendar: calendar('apple') }).canUseDefaultReminders,
    ).toBe(false);
  });

  it('offers RSVP only for a Google event the user is invited to', () => {
    expect(editorCapabilities({ ...base, hasOwnAttendee: true }).canRsvp).toBe(true);
    expect(
      editorCapabilities({ ...base, hasOwnAttendee: true, sourceCalendar: calendar('apple') })
        .canRsvp,
    ).toBe(false);
  });

  it('opens events of calendars we cannot write as viewers that cannot move', () => {
    const viewer = editorCapabilities({ ...base, sourceCalendar: calendar('apple', 'reader') });
    expect(viewer.readOnly).toBe(true);
    expect(viewer.canMoveCalendar).toBe(false);
  });

  it('moves a recurring event only when the whole series is edited', () => {
    expect(editorCapabilities({ ...base, isRecurring: true }).canMoveCalendar).toBe(false);
    expect(
      editorCapabilities({ ...base, isRecurring: true, scope: 'following' }).canMoveCalendar,
    ).toBe(false);
    expect(
      editorCapabilities({ ...base, isRecurring: true, scope: 'series' }).canMoveCalendar,
    ).toBe(true);
    expect(editorCapabilities({ ...base, isExisting: false }).canMoveCalendar).toBe(false);
  });

  it('keeps an existing repeating event timed or all-day', () => {
    expect(editorCapabilities({ ...base, isRecurring: true }).canSwitchAllDay).toBe(false);
    expect(editorCapabilities(base).canSwitchAllDay).toBe(true);
    expect(
      editorCapabilities({ ...base, isExisting: false, isRecurring: true }).canSwitchAllDay,
    ).toBe(true);
  });
});

describe('recurringTimesError', () => {
  const opened = { date: '2026-07-04', isAllDay: true };

  it('refuses a switch between timed and all-day in any scope', () => {
    for (const scope of ['instance', 'following', 'series'] as const) {
      expect(recurringTimesError({ date: '2026-07-04', isAllDay: false, opened, scope })).toMatch(
        /cannot switch/,
      );
    }
  });

  it('moves an all-day occurrence only on its own', () => {
    expect(
      recurringTimesError({ date: '2026-07-05', isAllDay: true, opened, scope: 'series' }),
    ).toMatch(/one occurrence at a time/);
    expect(
      recurringTimesError({ date: '2026-07-05', isAllDay: true, opened, scope: 'instance' }),
    ).toBeUndefined();
    expect(
      recurringTimesError({ date: '2026-07-04', isAllDay: true, opened, scope: 'series' }),
    ).toBeUndefined();
  });

  it('lets a timed series move by its wall-clock delta', () => {
    expect(
      recurringTimesError({
        date: '2026-07-05',
        isAllDay: false,
        opened: { date: '2026-07-04', isAllDay: false },
        scope: 'series',
      }),
    ).toBeUndefined();
  });
});

describe('repeatScopeError', () => {
  it('asks for a series scope only once the rule was edited on an occurrence', () => {
    expect(repeatScopeError({ dirty: true, isRecurring: true, scope: 'instance' })).toMatch(
      /All events/,
    );
    expect(repeatScopeError({ dirty: true, isRecurring: true, scope: 'series' })).toBeUndefined();
    expect(
      repeatScopeError({ dirty: true, isRecurring: true, scope: 'following' }),
    ).toBeUndefined();
    expect(
      repeatScopeError({ dirty: false, isRecurring: true, scope: 'instance' }),
    ).toBeUndefined();
    // A new event's rule is not scoped at all.
    expect(
      repeatScopeError({ dirty: true, isRecurring: false, scope: 'instance' }),
    ).toBeUndefined();
  });
});
