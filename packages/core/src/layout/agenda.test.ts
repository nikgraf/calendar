import { describe, expect, it } from 'vitest';
import { Temporal } from '../time/temporal.ts';
import { BirthdayOccurrence, BirthdayRecord, EventRecord, TaskRecord } from '../types.ts';
import { type AgendaItem, buildAgenda } from './agenda.ts';

const ZONE = 'Europe/Vienna';
const TODAY = '2026-10-02';
const days = [0, 1, 2].map((offset) => Temporal.PlainDate.from(TODAY).add({ days: offset }));

const at = (date: string, time: string) =>
  Temporal.PlainDateTime.from(`${date}T${time}`).toZonedDateTime(ZONE).epochMilliseconds;

const event = (id: string, date: string, start: string, end: string) =>
  new EventRecord({
    accountId: 'acc',
    calendarId: 'cal',
    endUtc: at(date, end),
    etag: null,
    id,
    isAllDay: false,
    startUtc: at(date, start),
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: id,
    updatedAt: 0,
  });

const allDayEvent = (id: string, startDate: string, endDate: string) =>
  new EventRecord({
    ...event(id, startDate, '00:00', '01:00'),
    endDate,
    isAllDay: true,
    startDate,
  });

const task = (id: string, overrides: Partial<TaskRecord> = {}) =>
  new TaskRecord({
    accountId: 'acc',
    id,
    listId: 'list',
    provider: 'apple',
    status: 'needsAction',
    title: id,
    updatedAt: 1,
    ...overrides,
  });

const birthday = (date: string) =>
  new BirthdayOccurrence({
    date,
    record: new BirthdayRecord({
      day: 3,
      displayName: 'Mara',
      id: 'mara',
      month: 10,
      sources: [],
    }),
  });

const label = (item: AgendaItem) =>
  item.kind === 'event'
    ? item.event.id
    : item.kind === 'task'
      ? item.task.id
      : item.birthday.record.displayName;

describe('buildAgenda', () => {
  it('lists every day, all-day items first, then the timed ones by the clock', () => {
    const agenda = buildAgenda({
      birthdays: [birthday('2026-10-03')],
      days,
      events: [
        event('design-review', TODAY, '11:00', '12:00'),
        event('standup', TODAY, '09:30', '09:45'),
        allDayEvent('offsite', '2026-09-30', '2026-10-04'),
        event('market', '2026-10-03', '09:00', '10:30'),
      ],
      tasks: [
        task('rent', { dueDate: '2026-09-17' }),
        task('hotel'),
        task('landlord', { dueDate: TODAY, dueTime: '10:00' }),
        task('invoice', { dueDate: TODAY }),
      ],
      timeZone: ZONE,
      today: TODAY,
    });
    expect(agenda.map((day) => day.date)).toEqual([TODAY, '2026-10-03', '2026-10-04']);
    // Overdue and undated tasks sit on today; the timed reminder lands by its time.
    expect(agenda[0]!.items.map(label)).toEqual([
      'offsite',
      'rent',
      'hotel',
      'invoice',
      'standup',
      'landlord',
      'design-review',
    ]);
    expect(agenda[1]!.items.map(label)).toEqual(['offsite', 'Mara', 'market']);
    expect(agenda[2]!.items).toEqual([]);
  });
});
