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

const MASTER_START = 1000;

describe('rescheduledEventExclusion', () => {
  const first = occurrence(1000);
  const edited = occurrence(2000);
  const later = occurrence(3000);
  // Edited on their own under Google's id: they keep their times through a series edit.
  const earlierException = occurrence(500, 'series_x1');
  const laterException = occurrence(4000, 'series_x2');
  const other = event('plain', { startUtc: 2000 });
  const elsewhere = event('series__2000', {
    calendarId: 'other',
    originalStartUtc: 2000,
    recurringEventId: 'series',
  });
  const rows = [first, edited, later, earlierException, laterException, other, elsewhere];
  const freed = (exclude: (row: EventRecord) => boolean) =>
    rows.filter(exclude).map((row) => row.id);

  it('is nothing for a new event, and the row itself for a single event', () => {
    expect(rescheduledEventExclusion(undefined, 'instance')).toBeUndefined();
    expect(freed(rescheduledEventExclusion(other, 'series')!)).toEqual(['plain']);
  });

  it('frees only the edited row for one occurrence, by identity', () => {
    const exclude = rescheduledEventExclusion(edited, 'instance', MASTER_START)!;
    expect(freed(exclude)).toEqual(['series__2000']);
    // The same slot under Google's own instance id (a sync landed mid-edit).
    expect(exclude(occurrence(2000, 'series_20261013T090000Z'))).toBe(true);
  });

  it('frees every drawn occurrence for all events; stored exceptions keep their times', () => {
    expect(freed(rescheduledEventExclusion(edited, 'series', MASTER_START)!)).toEqual([
      'series__1000',
      'series__2000',
      'series__3000',
    ]);
    // Opened on an exception: the master shifts and the exception stays put.
    expect(freed(rescheduledEventExclusion(laterException, 'series', MASTER_START)!)).toEqual([
      'series__1000',
      'series__2000',
      'series__3000',
    ]);
  });

  it('frees everything from the split for this and following, drawn or stored', () => {
    expect(freed(rescheduledEventExclusion(edited, 'following', MASTER_START)!)).toEqual([
      'series__2000',
      'series__3000',
      'series_x2',
    ]);
  });

  it('treats this and following from the first occurrence as all events', () => {
    expect(freed(rescheduledEventExclusion(first, 'following', MASTER_START)!)).toEqual([
      'series__1000',
      'series__2000',
      'series__3000',
    ]);
  });

  it('keeps stored exceptions busy while the master is not here yet', () => {
    expect(freed(rescheduledEventExclusion(edited, 'following')!)).toEqual([
      'series__2000',
      'series__3000',
    ]);
  });
});
