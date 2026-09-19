import { describe, expect, it } from 'vitest';
import { Attendee } from '../types.ts';
import { isLossy, isServerMove, moveLoss, moveLossSummary } from './moveLoss.ts';

const invited = {
  attendees: [
    new Attendee({
      email: 'me@example.com',
      isOrganizer: true,
      isSelf: true,
      responseStatus: 'accepted',
    }),
    new Attendee({ email: 'ana@example.com', responseStatus: 'accepted' }),
    new Attendee({ email: 'ben@example.com', responseStatus: 'needsAction' }),
    new Attendee({ email: 'room@example.com', isResource: true, responseStatus: 'accepted' }),
  ],
  hangoutLink: 'https://meet.google.com/abc-defg-hij',
  isAllDay: false,
  recurrence: ['RRULE:FREQ=WEEKLY', 'EXDATE:20260714T090000Z'],
};

describe('moveLoss', () => {
  it('loses nothing inside one Google account (server move)', () => {
    const route = { sameAccount: true, source: 'google', target: 'google' } as const;
    expect(isServerMove(route)).toBe(true);
    expect(isLossy(moveLoss(invited, route, 3))).toBe(false);
  });

  it('loses nothing between two Apple calendars', () => {
    const route = { sameAccount: true, source: 'apple', target: 'apple' } as const;
    expect(isLossy(moveLoss(invited, route, 2))).toBe(false);
  });

  it('drops guests, link and modified occurrences across Google accounts', () => {
    const loss = moveLoss(invited, { sameAccount: false, source: 'google', target: 'google' }, 2);
    expect(loss).toEqual({
      attendees: 2,
      meetingLink: true,
      modifiedOccurrences: 2,
      unsupportedRuleParts: [],
    });
    expect(moveLossSummary(loss)).toBe(
      'Moving this event to another account drops 2 guests, the meeting link and 2 modified occurrences.',
    );
  });

  it('keeps the link but names unsupported rule parts on Google → Apple', () => {
    const loss = moveLoss(invited, { sameAccount: false, source: 'google', target: 'apple' }, 0);
    expect(loss.meetingLink).toBe(false);
    expect(loss.unsupportedRuleParts).toEqual(['EXDATE']);
    expect(moveLossSummary(loss)).toContain(
      'repeat rules the target calendar cannot store (EXDATE)',
    );
  });

  it('is empty for a plain event moving Apple → Google', () => {
    const loss = moveLoss(
      { isAllDay: false },
      { sameAccount: false, source: 'apple', target: 'google' },
      0,
    );
    expect(isLossy(loss)).toBe(false);
    expect(moveLossSummary(loss)).toBeNull();
  });
});
