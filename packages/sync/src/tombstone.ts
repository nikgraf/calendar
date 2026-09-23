import { EventRecord, plainDateToUtcMs } from '@calendar/core';
import { type GcalEvent, instantMs } from '@calendar/google';

const plainDateMs = (isoDate: string): number | undefined => {
  try {
    return plainDateToUtcMs(isoDate);
  } catch {
    return undefined;
  }
};

/**
 * Cancelled instances of recurring events arrive without times but with
 * originalStartTime; they must be stored as tombstones so expansion drops
 * the shadowed occurrence.
 */
export const cancelledOverrideTombstone = (
  item: GcalEvent,
  context: { accountId: string; calendarId: string; syncedAt: number },
): EventRecord | null => {
  const original = item.originalStartTime;
  // Tolerant like mapGcalEvent: a malformed originalStartTime skips this
  // tombstone instead of failing the calendar's pass with a defect.
  const originalStartUtc = original?.dateTime
    ? instantMs(original.dateTime)
    : original?.date
      ? plainDateMs(original.date)
      : undefined;
  if (!item.recurringEventId || originalStartUtc === undefined) {
    return null;
  }
  return new EventRecord({
    accountId: context.accountId,
    calendarId: context.calendarId,
    endUtc: originalStartUtc,
    etag: item.etag ?? null,
    id: item.id,
    isAllDay: original?.date !== undefined,
    originalStartUtc,
    recurringEventId: item.recurringEventId,
    startUtc: originalStartUtc,
    status: 'cancelled',
    syncedAt: context.syncedAt,
    syncStatus: 'synced',
    title: '',
    updatedAt: context.syncedAt,
  });
};
