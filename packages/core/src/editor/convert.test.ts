import { describe, expect, it } from 'vite-plus/test';
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
