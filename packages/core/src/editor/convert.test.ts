import { describe, expect, it } from 'vitest';
import { EventReminders, ReminderOverride } from '../types.ts';
import {
  appendLink,
  type EventConvertValues,
  eventValuesToTaskValues,
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
    expect(eventValuesToTaskValues(event, 'apple', 'Europe/Berlin')).toEqual({
      alarms: [-10, -60],
      completed: false,
      dueDate: '2026-10-05',
      dueTime: '09:30',
      notes: '',
      title: 'Dentist',
    });
  });

  it('leaves an all-day event untimed and resolves calendar-default notifications', () => {
    const values = eventValuesToTaskValues(
      {
        ...event,
        isAllDay: true,
        reminders: new EventReminders({ overrides: [], useDefault: true }),
      },
      'apple',
      'UTC',
    );
    expect(values.dueTime).toBeUndefined();
    expect(values.alarms).toEqual([-30]);
  });

  it('puts the meeting link in the URL and, for Google Tasks, into the notes', () => {
    const meet = {
      ...event,
      description: 'Agenda',
      hangoutLink: 'https://meet.google.com/abc-defg-hij',
    };
    expect(eventValuesToTaskValues(meet, 'apple', 'UTC')).toMatchObject({
      notes: 'Agenda',
      url: 'https://meet.google.com/abc-defg-hij',
    });
    expect(eventValuesToTaskValues(meet, 'google', 'UTC')).toMatchObject({
      notes: 'Agenda\n\nhttps://meet.google.com/abc-defg-hij',
      url: 'https://meet.google.com/abc-defg-hij',
    });
    expect(eventValuesToTaskValues({ ...event, url: 'https://x.test' }, 'apple', 'UTC').url).toBe(
      'https://x.test',
    );
  });

  it('carries a rule a reminder can hold and drops one it cannot', () => {
    expect(
      eventValuesToTaskValues(
        { ...event, recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261130T235959Z'] },
        'apple',
        'Europe/Berlin',
      ).recurrence,
    ).toEqual({
      byDay: [{ weekday: 'MO' }, { weekday: 'WE' }],
      freq: 'weekly',
      interval: 1,
      untilDate: '2026-11-30',
    });
    expect(
      eventValuesToTaskValues(
        { ...event, recurrence: ['RRULE:FREQ=MONTHLY;BYMONTHDAY=1'] },
        'apple',
        'UTC',
      ).recurrence,
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
      title: 'Call mom',
      url: 'https://example.com/form',
    });
  });

  it('appends the URL to the description on Google and defers to the calendar without alarms', () => {
    const values = taskValuesToEventValues({ ...task, alarms: [] }, 'google');
    expect(values.description).toBe('Bring the form\n\nhttps://example.com/form');
    expect(values.url).toBeUndefined();
    expect(values.reminders).toEqual(new EventReminders({ overrides: [], useDefault: true }));
    expect(taskValuesToEventValues({ ...task, alarms: [] }, 'apple').reminders).toEqual(
      new EventReminders({ overrides: [], useDefault: false }),
    );
  });

  it('makes an untimed task all-day, ends the last hour at 23:59 and builds the rule', () => {
    const allDay = taskValuesToEventValues(
      { ...task, dueTime: undefined, recurrence: { freq: 'weekly', interval: 2 } },
      'google',
    );
    expect(allDay.isAllDay).toBe(true);
    expect(allDay.recurrence).toEqual(['RRULE:FREQ=WEEKLY;INTERVAL=2']);
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
