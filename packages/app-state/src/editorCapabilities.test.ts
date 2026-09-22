import { CalendarInfo } from '@calendar/core';
import { describe, expect, it } from 'vitest';
import { editorCapabilities } from './editorModel.ts';

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
});
