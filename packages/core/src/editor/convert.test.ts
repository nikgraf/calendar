import { describe, expect, it } from 'vite-plus/test';
import { EventReminders, ReminderOverride } from '../types.ts';
import {
  appendLink,
  convertSourceOf,
  type EventConvertValues,
  eventValuesToTaskValues,
  seriesConvertsAt,
  type TaskConvertValues,
  taskValuesToEventValues,
} from './convert.ts';

const popups = (...minutes: Array<number>) =>
  new EventReminders({
    overrides: minutes.map((m) => new ReminderOverride({ method: 'popup', minutes: m })),
    useDefault: false,
  });

const event: EventConvertValues = {
  attendees: [],
  date: '2026-10-05',
  defaultReminderMinutes: [30],
  endTime: '10:30',
  isAllDay: false,
  reminders: popups(10, 60),
  startTime: '09:30',
  timeChosen: true,
  title: 'Dentist',
};

const task: TaskConvertValues = {
  alarms: [-15, 0],
  completed: false,
  dueDate: '2026-10-05',
  dueTime: '14:00',
  notes: 'Bring the form',
  title: 'Call mom',
  url: 'https://example.com/form',
};

describe('converting a series', () => {
  const address = { accountId: 'acc', calendarId: 'cal' };
  const generated = {
    ...address,
    id: 'series_20261005T093000Z',
    originalStartUtc: 100,
    recurringEventId: 'series',
    startUtc: 100,
  };
  // Moved on its own: it is still the occurrence its rule drew at 100.
  const moved = { ...generated, startUtc: 900 };
  const master = {
    ...address,
    id: 'series',
    recurrence: ['RRULE:FREQ=WEEKLY'],
    recurringEventId: undefined,
    startUtc: 100,
  };
  const single = { ...address, id: 'one', recurringEventId: undefined, startUtc: 100 };

  it('names one occurrence by its slot at "This event" and the whole series otherwise', () => {
    expect(convertSourceOf(generated, 'instance')).toEqual({
      ...address,
      eventId: 'series',
      occurrence: { originalStartUtc: 100 },
    });
    expect(convertSourceOf(moved, 'instance')?.occurrence).toEqual({ originalStartUtc: 100 });
    expect(convertSourceOf(generated, 'series')).toEqual({ ...address, eventId: 'series' });
  });

  it('names nothing where a series does not convert, never more than the scope stands for', () => {
    expect(convertSourceOf(generated, 'following')).toBeUndefined();
    expect(convertSourceOf(moved, 'following')).toBeUndefined();
    // A master row names no occurrence: it is the series, at "All events" only.
    expect(convertSourceOf(master, 'instance')).toBeUndefined();
    expect(convertSourceOf(master, 'following')).toBeUndefined();
    expect(convertSourceOf(master, 'series')).toEqual({ ...address, eventId: 'series' });
  });

  it('names an event that does not repeat as itself, whatever the scope', () => {
    for (const scope of ['instance', 'following', 'series'] as const) {
      expect(convertSourceOf(single, scope)).toEqual({ ...address, eventId: 'one' });
    }
  });

  it('converts at "This event" and "All events", never at "This and following"', () => {
    expect(seriesConvertsAt(generated, 'instance')).toBe(true);
    expect(seriesConvertsAt(generated, 'series')).toBe(true);
    expect(seriesConvertsAt(generated, 'following')).toBe(false);
    // A master row names no occurrence: only the whole series converts.
    expect(seriesConvertsAt(master, 'instance')).toBe(false);
    expect(seriesConvertsAt(master, 'series')).toBe(true);
  });
});

describe('appendLink', () => {
  it('adds the link after the text unless it is already there', () => {
    expect(appendLink('Notes', 'https://x.test')).toBe('Notes\n\nhttps://x.test');
    expect(appendLink(undefined, 'https://x.test')).toBe('https://x.test');
    expect(appendLink('See https://x.test', 'https://x.test')).toBe('See https://x.test');
    expect(appendLink('Notes', 'https://x.test', 'https://x.test')).toBe('Notes');
    expect(appendLink('Notes', undefined)).toBe('Notes');
  });
});

describe('eventValuesToTaskValues', () => {
  it('carries the day and time, notifications as alarms and the title', () => {
    expect(eventValuesToTaskValues(event, 'Europe/Berlin')).toEqual({
      alarms: [-10, -60],
      completed: false,
      dueDate: '2026-10-05',
      dueTime: '09:30',
      notes: '',
      title: 'Dentist',
    });
  });

  it('leaves an all-day event, or an unchosen slot default, untimed and resolves calendar-default notifications', () => {
    const values = eventValuesToTaskValues(
      {
        ...event,
        isAllDay: true,
        reminders: new EventReminders({ overrides: [], useDefault: true }),
      },
      'UTC',
    );
    expect(values.dueTime).toBeUndefined();
    expect(values.alarms).toEqual([-30]);
    expect(eventValuesToTaskValues({ ...event, timeChosen: false }, 'UTC').dueTime).toBeUndefined();
  });

  it('puts the meeting link in the URL and leaves the notes to the description', () => {
    const meet = {
      ...event,
      description: 'Agenda',
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
    };
    expect(eventValuesToTaskValues(meet, 'UTC')).toMatchObject({
      notes: 'Agenda',
      url: 'https://meet.google.com/abc-defg-hij',
    });
    expect(eventValuesToTaskValues({ ...event, url: 'https://x.test' }, 'UTC').url).toBe(
      'https://x.test',
    );
  });

  it('carries a rule a reminder can hold and drops one it cannot', () => {
    expect(
      eventValuesToTaskValues(
        { ...event, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261130T235959Z'] },
        'Europe/Berlin',
      ).recurrence,
    ).toEqual({
      byDay: [{ weekday: 'MO' }, { weekday: 'WE' }],
      freq: 'weekly',
      interval: 1,
      untilDate: '2026-11-30',
    });
    expect(
      eventValuesToTaskValues({ ...event, recurrence: ['RRULE:FREQ=MONTHLY;BYMONTHDAY=1'] }, 'UTC')
        .recurrence,
    ).toBeUndefined();
  });
});

describe('taskValuesToEventValues', () => {
  it('makes a one-hour event at the due time with the alarms as notifications', () => {
    expect(taskValuesToEventValues(task, 'apple')).toEqual({
      attendees: [],
      date: '2026-10-05',
      defaultReminderMinutes: [],
      description: 'Bring the form',
      endTime: '15:00',
      isAllDay: false,
      reminders: popups(0, 15),
      startTime: '14:00',
      timeChosen: true,
      title: 'Call mom',
      url: 'https://example.com/form',
    });
  });

  it('keeps the URL apart from the description and defers to the calendar without alarms', () => {
    const values = taskValuesToEventValues({ ...task, alarms: [] }, 'google');
    expect(values.description).toBe('Bring the form');
    expect(values.url).toBe('https://example.com/form');
    expect(values.reminders).toEqual(new EventReminders({ overrides: [], useDefault: true }));
    expect(taskValuesToEventValues({ ...task, alarms: [] }, 'apple').reminders).toEqual(
      new EventReminders({ overrides: [], useDefault: false }),
    );
  });

  it('makes an untimed task all-day, ends the last hour at 23:59 and carries the rule as it is', () => {
    const rule = { freq: 'weekly', interval: 2, untilDate: '2026-09-30' } as const;
    const allDay = taskValuesToEventValues(
      { ...task, dueTime: undefined, recurrence: rule },
      'google',
    );
    expect(allDay.isAllDay).toBe(true);
    expect(allDay.repeat).toEqual(rule);
    expect(allDay.recurrence).toBeUndefined();
    expect(taskValuesToEventValues({ ...task, dueTime: '23:30' }, 'google')).toMatchObject({
      endTime: '23:59',
      startTime: '23:30',
    });
    // Alerts after the due time have no notification equivalent.
    expect(taskValuesToEventValues({ ...task, alarms: [30] }, 'apple').reminders.overrides).toEqual(
      [],
    );
  });
});
