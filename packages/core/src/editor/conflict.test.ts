import { describe, expect, it } from 'vitest';
import { EventRecord } from '../types.ts';
import { conflictChoiceLabels, conflictTimeLabel, describeConflict } from './conflict.ts';

const TZ = 'Europe/Vienna';

const event = (overrides: Partial<EventRecord> = {}) =>
  new EventRecord({
    accountId: 'a',
    calendarId: 'c',
    // 09:00–10:00 Vienna (UTC+2 in September).
    endUtc: Date.parse('2026-09-22T08:00:00Z'),
    etag: null,
    id: 'e1',
    isAllDay: false,
    startUtc: Date.parse('2026-09-22T07:00:00Z'),
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'pending',
    title: 'Standup',
    updatedAt: 0,
    ...overrides,
  });

describe('conflictTimeLabel', () => {
  it('prints a timed event on one day', () => {
    expect(conflictTimeLabel(event(), TZ)).toBe('Tue, Sep 22, 9:00 AM – 10:00 AM');
  });

  it('prints an all-day span with its last day inclusive', () => {
    const allDay = event({ endDate: '2026-09-25', isAllDay: true, startDate: '2026-09-22' });
    expect(conflictTimeLabel(allDay, TZ)).toBe('Tue, Sep 22 – Thu, Sep 24');
    expect(conflictTimeLabel({ ...allDay, endDate: '2026-09-23' } as EventRecord, TZ)).toBe(
      'Tue, Sep 22 (all day)',
    );
  });
});

describe('describeConflict', () => {
  it('names the event and lists what differs', () => {
    const mine = event({ title: 'Standup (moved)' });
    const theirs = event({
      endUtc: Date.parse('2026-09-22T09:00:00Z'),
      location: 'Room 4',
      startUtc: Date.parse('2026-09-22T08:00:00Z'),
    });
    const description = describeConflict(
      { conflict: { mine, theirs }, kind: 'update', title: mine.title },
      TZ,
    );
    expect(description.headline).toBe(
      '“Standup (moved)” changed on Google while your edit waited.',
    );
    expect(description.changes).toEqual([
      { label: 'Title', mine: 'Standup (moved)', theirs: 'Standup' },
      {
        label: 'Time',
        mine: 'Tue, Sep 22, 9:00 AM – 10:00 AM',
        theirs: 'Tue, Sep 22, 10:00 AM – 11:00 AM',
      },
      { label: 'Location', mine: 'none', theirs: 'Room 4' },
    ]);
    expect(conflictChoiceLabels({ conflict: { mine, theirs }, kind: 'update' })).toEqual({
      mine: 'Keep mine',
      theirs: 'Take theirs',
    });
  });

  it('says so when Google deleted the event an edit was waiting on', () => {
    const input = { conflict: { mine: event(), theirs: null }, kind: 'update', title: 'Standup' };
    expect(describeConflict(input, TZ)).toEqual({
      changes: [],
      headline: '“Standup” was deleted on Google while your edit waited.',
    });
    expect(conflictChoiceLabels(input)).toEqual({ mine: 'Restore mine', theirs: 'Let it go' });
  });

  it('phrases a parked delete', () => {
    const input = {
      conflict: { mine: event(), theirs: event({ title: 'Standup v2' }) },
      kind: 'delete',
      title: 'Standup',
    };
    expect(describeConflict(input, TZ).headline).toBe(
      '“Standup” changed on Google before your delete reached it.',
    );
    expect(conflictChoiceLabels(input)).toEqual({ mine: 'Delete anyway', theirs: 'Keep theirs' });
  });
});
