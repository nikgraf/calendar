import { EventRecord } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import { rescheduledEventExclusion } from './findTimeModel.ts';

const event = (id: string, overrides: Partial<EventRecord> = {}) =>
  new EventRecord({
    accountId: 'acc',
    calendarId: 'cal',
    endUtc: 2000,
    etag: null,
    id,
    isAllDay: false,
    startUtc: 1000,
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: id,
    updatedAt: 0,
    ...overrides,
  });

/** An occurrence as the window draws it: `<master>__<originalStart>`. */
const occurrence = (originalStartUtc: number, id = `series__${originalStartUtc}`) =>
  event(id, { originalStartUtc, recurringEventId: 'series', startUtc: originalStartUtc });

describe('rescheduledEventExclusion', () => {
  const earlier = occurrence(1000);
  const edited = occurrence(2000);
  const later = occurrence(3000);
  // Edited on its own under Google's id: it keeps its times through a series edit.
  const exception = occurrence(4000, 'series_20261014T090000Z');
  const other = event('plain', { startUtc: 2000 });
  const elsewhere = event('series__2000', {
    calendarId: 'other',
    originalStartUtc: 2000,
    recurringEventId: 'series',
  });

  it('is nothing for a new event', () => {
    expect(rescheduledEventExclusion(undefined, 'instance')).toBeUndefined();
  });

  it('frees only the edited row for one occurrence', () => {
    const exclude = rescheduledEventExclusion(edited, 'instance')!;
    expect([earlier, edited, later, exception, other, elsewhere].map(exclude)).toEqual([
      false,
      true,
      false,
      false,
      false,
      false,
    ]);
    // The same slot under Google's own instance id (a sync landed mid-edit).
    expect(exclude(occurrence(2000, 'series_20261013T090000Z'))).toBe(true);
  });

  it('frees this and the later drawn occurrences for a following edit, every drawn one for the series', () => {
    const following = rescheduledEventExclusion(edited, 'following')!;
    expect([earlier, edited, later, exception, other].map(following)).toEqual([
      false,
      true,
      true,
      false,
      false,
    ]);
    const series = rescheduledEventExclusion(edited, 'series')!;
    expect([earlier, edited, later, exception, other].map(series)).toEqual([
      true,
      true,
      true,
      false,
      false,
    ]);
  });

  it('frees a stored exception only when it is the row being edited', () => {
    expect(rescheduledEventExclusion(exception, 'series')!(exception)).toBe(true);
    expect(rescheduledEventExclusion(edited, 'series')!(exception)).toBe(false);
  });
});
