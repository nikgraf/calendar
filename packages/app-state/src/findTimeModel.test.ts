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

const occurrence = (id: string, originalStartUtc: number) =>
  event(id, { originalStartUtc, recurringEventId: 'series', startUtc: originalStartUtc });

describe('rescheduledEventExclusion', () => {
  const earlier = occurrence('occ-1', 1000);
  const edited = occurrence('occ-2', 2000);
  const later = occurrence('occ-3', 3000);
  const other = event('plain', { startUtc: 2000 });
  const elsewhere = event('occ-2', { calendarId: 'other' });

  it('is nothing for a new event', () => {
    expect(rescheduledEventExclusion(undefined, 'instance')).toBeUndefined();
  });

  it('frees only the edited row for one occurrence', () => {
    const exclude = rescheduledEventExclusion(edited, 'instance')!;
    expect([earlier, edited, later, other, elsewhere].map(exclude)).toEqual([
      false,
      true,
      false,
      false,
      false,
    ]);
  });

  it('frees this and the later occurrences for a following edit, every one for the series', () => {
    const following = rescheduledEventExclusion(edited, 'following')!;
    expect([earlier, edited, later, other].map(following)).toEqual([false, true, true, false]);
    const series = rescheduledEventExclusion(edited, 'series')!;
    expect([earlier, edited, later, other].map(series)).toEqual([true, true, true, false]);
  });
});
