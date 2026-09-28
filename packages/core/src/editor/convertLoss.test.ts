import { describe, expect, it } from 'vitest';
import { EventReminders, ReminderOverride } from '../types.ts';
import {
  eventToTaskLoss,
  eventToTaskLossSummary,
  isEventToTaskLossy,
  isTaskToEventLossy,
  taskToEventLoss,
  taskToEventLossSummary,
} from './convertLoss.ts';

const reminders = (useDefault: boolean, ...overrides: Array<['email' | 'popup', number]>) =>
  new EventReminders({
    overrides: overrides.map(([method, minutes]) => new ReminderOverride({ method, minutes })),
    useDefault,
  });

describe('eventToTaskLoss', () => {
  it('loses nothing for a timed event heading for a Reminders list', () => {
    const loss = eventToTaskLoss(
      { isAllDay: false, reminders: reminders(false, ['popup', 10]) },
      'apple',
      0,
    );
    expect(isEventToTaskLossy(loss)).toBe(false);
    expect(eventToTaskLossSummary(loss, 'Switching to a task')).toBeNull();
  });

  it('counts the time and every explicit notification toward Google Tasks', () => {
    const loss = eventToTaskLoss(
      { isAllDay: false, reminders: reminders(false, ['popup', 10], ['email', 60]) },
      'google',
      0,
    );
    expect(loss).toEqual({
      attendees: 0,
      dueTime: true,
      location: false,
      modifiedOccurrences: 0,
      recurrence: false,
      reminders: 2,
    });
    expect(eventToTaskLossSummary(loss, 'Converting this event to a task')).toBe(
      'Converting this event to a task drops the time and 2 notifications.',
    );
    // The editor's untouched slot default is not a time anyone chose.
    expect(eventToTaskLoss({ isAllDay: false, timeChosen: false }, 'google', 0).dueTime).toBe(
      false,
    );
  });

  it('ignores calendar-default notifications and counts only email ones toward Reminders', () => {
    expect(
      eventToTaskLoss({ isAllDay: true, reminders: reminders(true) }, 'google', 0).reminders,
    ).toBe(0);
    expect(
      eventToTaskLoss(
        { isAllDay: true, reminders: reminders(false, ['popup', 10], ['email', 60]) },
        'apple',
        0,
      ).reminders,
    ).toBe(1);
  });

  it('counts guests (rooms, organizer and self excluded), the location and modified occurrences', () => {
    const loss = eventToTaskLoss(
      {
        attendees: [
          { email: 'a@example.com' },
          { email: 'room@example.com', isResource: true },
          { email: 'me@example.com', isOrganizer: true, isSelf: true },
          { email: 'b@example.com' },
        ],
        isAllDay: true,
        location: 'Room 4B',
      },
      'apple',
      2,
    );
    expect(loss.attendees).toBe(2);
    expect(eventToTaskLossSummary(loss, 'Converting this event to a reminder')).toBe(
      'Converting this event to a reminder drops 2 guests, the location and 2 modified occurrences.',
    );
    expect(eventToTaskLoss({ isAllDay: true, location: '  ' }, 'apple', 0).location).toBe(false);
  });

  it('keeps a rule a reminder can hold and names one it cannot, or any rule toward Google', () => {
    const weekly = ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE'];
    expect(eventToTaskLoss({ isAllDay: false, recurrence: weekly }, 'apple', 0).recurrence).toBe(
      false,
    );
    expect(eventToTaskLoss({ isAllDay: false, recurrence: weekly }, 'google', 0).recurrence).toBe(
      true,
    );
    expect(
      eventToTaskLoss(
        { isAllDay: false, recurrence: ['RRULE:FREQ=MONTHLY;BYMONTHDAY=1'] },
        'apple',
        0,
      ).recurrence,
    ).toBe(true);
    expect(eventToTaskLoss({ isAllDay: false, recurrence: [] }, 'google', 0).recurrence).toBe(
      false,
    );
  });
});

describe('taskToEventLoss', () => {
  it('names the priority, alerts after the due time, an inexpressible rule and completion', () => {
    const loss = taskToEventLoss({
      alarms: [-15, 30, 60],
      priority: 'high',
      recurrenceUnsupported: true,
      status: 'completed',
    });
    expect(loss).toEqual({ alarmsAfterDue: 2, completed: true, priority: true, recurrence: true });
    expect(isTaskToEventLossy(loss)).toBe(true);
    expect(taskToEventLossSummary(loss, 'Converting this task to an event')).toBe(
      'Converting this task to an event drops the priority, 2 alerts after the due time, the repeat rule and the completed status.',
    );
  });

  it('loses nothing for a plain reminder with alerts before the due time and a rule', () => {
    const loss = taskToEventLoss({ alarms: [-15, 0], status: 'needsAction' });
    expect(isTaskToEventLossy(loss)).toBe(false);
    expect(taskToEventLossSummary(loss, 'Switching to an event')).toBeNull();
  });
});
