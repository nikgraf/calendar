import { describe, expect, it } from 'vite-plus/test';
import { plainDateToUtcMs } from '../time/convert.ts';
import { Temporal } from '../time/temporal.ts';
import {
  searchDateLabel,
  searchEventWhen,
  searchFilterChips,
  searchQuerySentence,
  searchTaskWhen,
  summarizeSearchChange,
} from './label.ts';

const VIENNA = 'Europe/Vienna';
const today = '2026-10-24';

const at = (wall: string, zone = VIENNA): number =>
  Temporal.PlainDateTime.from(wall).toZonedDateTime(zone).epochMilliseconds;

const timed = (start: string, end: string, zone = VIENNA) => ({
  endUtc: at(end, zone),
  isAllDay: false,
  startUtc: at(start, zone),
});

const allDay = (startDate: string, endDate: string) => ({
  endDate,
  endUtc: plainDateToUtcMs(endDate),
  isAllDay: true,
  startDate,
  startUtc: plainDateToUtcMs(startDate),
});

describe('searchEventWhen', () => {
  it('names the day and the times in the zone', () => {
    expect(searchEventWhen(timed('2026-10-27T09:00', '2026-10-27T10:30'), VIENNA, today)).toBe(
      'Tue, Oct 27 · 9:00 – 10:30 AM',
    );
    // The same instants read in New York.
    expect(
      searchEventWhen(timed('2026-10-27T09:00', '2026-10-27T10:30'), 'America/New_York', today),
    ).toBe('Tue, Oct 27 · 4:00 – 5:30 AM');
  });

  it("adds the year to a date outside today's year", () => {
    expect(searchEventWhen(timed('2027-01-05T18:00', '2027-01-05T19:00'), VIENNA, today)).toBe(
      'Tue, Jan 5, 2027 · 6:00 – 7:00 PM',
    );
  });

  it('spells out both ends of an event across midnight, but not one ending at it', () => {
    expect(searchEventWhen(timed('2026-10-24T22:00', '2026-10-25T01:00'), VIENNA, today)).toBe(
      'Sat, Oct 24, 10:00 PM – Sun, Oct 25, 1:00 AM',
    );
    expect(searchEventWhen(timed('2026-10-24T23:00', '2026-10-25T00:00'), VIENNA, today)).toBe(
      'Sat, Oct 24 · 11:00 PM – 12:00 AM',
    );
  });

  it('dates the end of a longer event at midnight by the day it ends on', () => {
    // Over two days into Monday's midnight: the end is Monday 12:00 AM, not Sunday's.
    expect(searchEventWhen(timed('2026-10-24T12:00', '2026-10-26T00:00'), VIENNA, today)).toBe(
      'Sat, Oct 24, 12:00 PM – Mon, Oct 26, 12:00 AM',
    );
  });

  it('says all day, with the last day of a longer one', () => {
    expect(searchEventWhen(allDay('2026-10-26', '2026-10-27'), VIENNA, today)).toBe(
      'Mon, Oct 26 · All day',
    );
    expect(searchEventWhen(allDay('2026-12-31', '2027-01-03'), VIENNA, today)).toBe(
      'Thu, Dec 31 – Sat, Jan 2, 2027 · All day',
    );
  });
});

describe('searchTaskWhen', () => {
  it('names the due day and time, or says there is none', () => {
    expect(searchTaskWhen({ dueDate: '2026-10-30' }, today)).toBe('Due Fri, Oct 30');
    expect(searchTaskWhen({ dueDate: '2025-03-02', dueTime: '14:15' }, today)).toBe(
      'Due Sun, Mar 2, 2025, 2:15 PM',
    );
    expect(searchTaskWhen({}, today)).toBe('No due date');
  });
});

const names = {
  calendars: [
    { accountId: 'acc', id: 'work', summary: 'Work' },
    { accountId: 'acc', id: 'home', summary: 'Home' },
  ],
  taskLists: [{ accountId: 'acc', id: 'groceries', title: 'Groceries' }],
  today,
};

describe('searchDateLabel', () => {
  it('names a range, a day, an open start or end', () => {
    expect(searchDateLabel('2026-10-01', '2026-10-31', today)).toBe('Oct 1 – Oct 31');
    expect(searchDateLabel('2026-10-14', '2026-10-14', today)).toBe('Oct 14');
    expect(searchDateLabel('2026-10-01', undefined, today)).toBe('from Oct 1');
    expect(searchDateLabel(undefined, '2027-01-05', today)).toBe('until Jan 5, 2027');
    expect(searchDateLabel(undefined, undefined, today)).toBeUndefined();
  });
});

describe('searchFilterChips', () => {
  it('lists the filters in the row’s order, calendars and lists by name', () => {
    expect(
      searchFilterChips(
        {
          allDay: false,
          calendars: ['acc:work', 'acc:gone'],
          from: '2026-10-01',
          kind: 'event',
          lists: ['acc:groceries'],
          location: 'Vienna',
          people: ['Anna', 'Bob'],
          terms: ['harbour'],
          to: '2026-10-31',
        },
        names,
      ),
    ).toEqual([
      { field: 'dates', label: 'Oct 1 – Oct 31' },
      { field: 'kind', label: 'Events only' },
      { field: 'calendar', key: 'acc:work', label: 'Work' },
      { field: 'calendar', key: 'acc:gone', label: 'Calendar' },
      { field: 'list', key: 'acc:groceries', label: 'Groceries' },
      { field: 'location', label: 'in Vienna' },
      { field: 'people', label: 'with Anna, Bob' },
      { field: 'allDay', label: 'Timed' },
    ]);
    expect(searchFilterChips({ terms: ['harbour'] }, names)).toEqual([]);
  });

  it('says the query in one line', () => {
    expect(searchQuerySentence({ location: 'Vienna', terms: ['harbour', 'lunch'] }, names)).toBe(
      '“harbour lunch” · in Vienna',
    );
  });
});

describe('summarizeSearchChange', () => {
  it('lists what changed, and what was taken away', () => {
    expect(
      summarizeSearchChange(
        { terms: ['harbour'] },
        { from: '2026-10-01', location: 'Hafen', terms: ['harbour'], to: '2026-10-31' },
        names,
      ),
    ).toBe('→ Oct 1 – Oct 31 · → in Hafen');
    expect(
      summarizeSearchChange(
        { calendars: ['acc:work'], from: '2026-10-01', kind: 'task', terms: ['a'] },
        { terms: ['b'] },
        names,
      ),
    ).toBe('→ “b” · → any time · → events and tasks · → any calendar');
    expect(summarizeSearchChange({ terms: ['a'] }, { terms: ['a'] }, names)).toBe('no change');
  });
});
