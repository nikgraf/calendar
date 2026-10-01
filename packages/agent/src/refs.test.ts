import { EventRecord } from '@calendar/core';
import { describe, expect, it } from 'vitest';
import {
  decodeCalendarRef,
  decodeEventRef,
  decodeTaskListRef,
  decodeTaskRef,
  encodeRef,
  eventRefOf,
  type ItemRef,
} from './refs.ts';

const record = (overrides: Partial<ConstructorParameters<typeof EventRecord>[0]>) =>
  new EventRecord({
    accountId: 'acc',
    calendarId: 'cal',
    endUtc: 2,
    etag: null,
    id: 'evt',
    isAllDay: false,
    startUtc: 1,
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: 'T',
    updatedAt: 0,
    ...overrides,
  });

describe('refs', () => {
  it('round-trips every kind, including ids with separators and non-ASCII', () => {
    const cases: ReadonlyArray<ItemRef> = [
      { accountId: 'acc:1', calendarId: 'nik@example.com', kind: 'calendar' },
      { accountId: 'a', calendarId: 'c', eventId: 'abc_20261001T090000Z', kind: 'event' },
      {
        accountId: 'a',
        calendarId: 'c__d',
        kind: 'occurrence',
        masterId: 'master__1',
        originalStartUtc: 1_790_000_000_000,
      },
      { accountId: 'apple-reminders', kind: 'task', taskId: 'x-ü-✓', taskListId: 'list/1' },
      { accountId: 'a', kind: 'taskList', taskListId: 'l' },
    ];
    for (const ref of cases) {
      const encoded = encodeRef(ref);
      const decoded =
        decodeCalendarRef(encoded) ??
        decodeEventRef(encoded) ??
        decodeTaskRef(encoded) ??
        decodeTaskListRef(encoded);
      expect(decoded).toEqual(ref);
      expect(encoded).toMatch(/^(cal|evt|task|list)_[\w-]+$/u);
    }
  });

  it('a ref of one kind never decodes as another', () => {
    const calendar = encodeRef({ accountId: 'a', calendarId: 'c', kind: 'calendar' });
    expect(decodeEventRef(calendar)).toBeUndefined();
    expect(decodeTaskRef(calendar)).toBeUndefined();
    expect(decodeTaskListRef(calendar)).toBeUndefined();
  });

  it('rejects anything that is not a well-formed ref', () => {
    for (const bad of ['', 'evt_', 'evt_!!!', 'evt_e30', 'cal_WyJhIl0', 'not-a-ref', 'evt_W10']) {
      expect(decodeEventRef(bad)).toBeUndefined();
      expect(decodeCalendarRef(bad)).toBeUndefined();
    }
    // Right shape, wrong member types.
    const numeric = `evt_${btoa(JSON.stringify(['a', 'c', 5]))}`;
    expect(decodeEventRef(numeric)).toBeUndefined();
  });

  it('names an occurrence by its master and slot, never by parsing the record id', () => {
    expect(eventRefOf(record({}))).toEqual({
      accountId: 'acc',
      calendarId: 'cal',
      eventId: 'evt',
      kind: 'event',
    });
    // An expanded occurrence and a stored exception both carry recurringEventId.
    expect(
      eventRefOf(
        record({
          id: 'master_20261001T090000Z',
          originalStartUtc: 500,
          recurringEventId: 'master',
        }),
      ),
    ).toEqual({
      accountId: 'acc',
      calendarId: 'cal',
      kind: 'occurrence',
      masterId: 'master',
      originalStartUtc: 500,
    });
  });
});
