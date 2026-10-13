import { CalendarInfo, TaskListInfo } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import {
  draftCalendarKey,
  draftListKey,
  planAddAll,
  taskFromPrefill,
  todoPrefillError,
} from './addAll.ts';
import { type Draft, type DraftExtras, focusDraft, startThread } from './draftThread.ts';
import type { QuickAddItem } from './quickAddItem.ts';

const TZ = 'Europe/Vienna';
const calendar = (
  accountId: string,
  id: string,
  provider: 'apple' | 'google' = 'google',
  accessRole: CalendarInfo['accessRole'] = 'owner',
) =>
  new CalendarInfo({
    accessRole,
    accountId,
    colorHex: '#123456',
    id,
    isPrimary: false,
    isVisible: true,
    provider,
    summary: id,
    timeZone: TZ,
  });
const calendars = [
  calendar('acc', 'work'),
  calendar('acc', 'home'),
  calendar('apple-calendar', 'family', 'apple'),
  calendar('acc', 'holidays', 'google', 'reader'),
];
const list = (accountId: string, id: string, readOnly = false) =>
  new TaskListInfo({
    accountId,
    id,
    isVisible: true,
    provider: accountId === 'apple-reminders' ? 'apple' : 'google',
    readOnly,
    title: id,
  });
const taskLists = [
  list('acc', 'inbox'),
  list('acc', 'errands'),
  list('apple-reminders', 'groceries'),
  list('apple-reminders', 'shared', true),
];
const defaults = { calendarKey: 'acc:work', listKey: 'acc:inbox' };

const event = (title: string, startTime = '09:00', endTime = '10:00'): QuickAddItem => ({
  kind: 'event',
  prefill: { date: '2026-08-28', endTime, isAllDay: false, startTime, title },
});
const todo = (title: string, time?: string): QuickAddItem => ({
  kind: 'task',
  prefill: { date: '2026-08-29', ...(time === undefined ? {} : { time }), title },
});
const held = (extras: Partial<DraftExtras>): DraftExtras => ({
  attendees: [],
  description: '',
  reminders: undefined,
  ...extras,
});
const ids = () => {
  let count = 0;
  return () => {
    count += 1;
    return `d${String(count)}`;
  };
};
/** A thread of drafts, each with the extras the form left on it, the first one focused. */
const thread = (...drafts: ReadonlyArray<[QuickAddItem, Partial<DraftExtras>?]>) => {
  const state = startThread(
    drafts.map(([item]) => item),
    'x',
    { id: ids() },
  );
  return {
    ...state,
    drafts: state.drafts.map((draft, index): Draft =>
      drafts[index]?.[1] ? { ...draft, extras: held(drafts[index][1]) } : draft,
    ),
  };
};

describe('draftCalendarKey and draftListKey', () => {
  it('keep the calendar or list a draft was given while it can still take one, else the form’s', () => {
    const given = (extras: Partial<DraftExtras>): Draft => ({
      extras: held(extras),
      id: 'd',
      item: event('x'),
    });
    expect(draftCalendarKey(given({ calendarKey: 'acc:home' }), calendars, 'acc:work')).toBe(
      'acc:home',
    );
    // Gone, or read-only since: the form's.
    expect(draftCalendarKey(given({ calendarKey: 'acc:gone' }), calendars, 'acc:work')).toBe(
      'acc:work',
    );
    expect(draftCalendarKey(given({ calendarKey: 'acc:holidays' }), calendars, 'acc:work')).toBe(
      'acc:work',
    );
    // Never given one: the form's.
    expect(draftCalendarKey({ id: 'd', item: event('x') }, calendars, 'acc:work')).toBe('acc:work');
    expect(
      draftListKey(given({ listKey: 'apple-reminders:groceries' }), taskLists, 'acc:inbox'),
    ).toBe('apple-reminders:groceries');
    expect(draftListKey(given({ listKey: 'apple-reminders:shared' }), taskLists, 'acc:inbox')).toBe(
      'acc:inbox',
    );
    expect(draftListKey({ id: 'd', item: todo('x') }, taskLists, 'acc:inbox')).toBe('acc:inbox');
  });
});

describe('planAddAll', () => {
  it('writes every draft beside the focused one, events and to-dos, each where it was put', () => {
    const state = thread(
      [event('Focused'), { calendarKey: 'acc:home' }],
      [event('Standup'), { calendarKey: 'apple-calendar:family' }],
      [
        todo('Buy milk', '18:00'),
        {
          listKey: 'apple-reminders:groceries',
          reminder: { alarms: [-15], priority: 'high', url: '' },
          taskNotes: ' oat ',
        },
      ],
      [todo('Call the bank')],
      [event('Review', '14:00', '15:00')],
    );
    const plan = planAddAll(state, { calendars, defaults, taskLists, timeZone: TZ });
    expect(plan.kind).toBe('ready');
    if (plan.kind !== 'ready') {
      return;
    }
    expect(plan.writes.map((write) => write.id)).toEqual(['d2', 'd3', 'd4', 'd5']);
    const [standup, milk, bank, review] = plan.writes;
    // An Apple calendar: no guests, notifications explicit.
    expect(standup).toMatchObject({
      event: {
        accountId: 'apple-calendar',
        calendarId: 'family',
        reminders: { overrides: [], useDefault: false },
        title: 'Standup',
      },
      kind: 'event',
    });
    expect(milk).toEqual({
      id: 'd3',
      kind: 'task',
      task: {
        accountId: 'apple-reminders',
        alarms: [-15],
        dueDate: '2026-08-29',
        dueTime: '18:00',
        notes: 'oat',
        priority: 'high',
        taskListId: 'groceries',
        title: 'Buy milk',
      },
    });
    // Never shown: where the form points now.
    expect(bank).toMatchObject({ kind: 'task', task: { accountId: 'acc', taskListId: 'inbox' } });
    expect(review).toMatchObject({
      event: { accountId: 'acc', calendarId: 'work', title: 'Review' },
      kind: 'event',
    });
    expect(review?.kind === 'event' ? review.event : undefined).not.toHaveProperty('reminders');
  });

  it('stops at the first draft Save would refuse, with Save’s reason, and writes nothing', () => {
    expect(
      planAddAll(thread([event('Ok')], [todo(' ')], [event('Backwards', '11:00', '10:00')]), {
        calendars,
        defaults,
        taskLists,
        timeZone: TZ,
      }),
    ).toEqual({ index: 1, kind: 'blocked', reason: 'A title and task list are required.' });
    const later = focusDraft(
      thread([event('Ok')], [todo(' ')], [event('Backwards', '11:00', '10:00')]),
      1,
    );
    expect(planAddAll(later, { calendars, defaults, taskLists, timeZone: TZ })).toMatchObject({
      index: 2,
      kind: 'blocked',
    });
    // No calendar to go to, or no list.
    expect(
      planAddAll(thread([event('Ok')], [event('Lunch')]), {
        calendars,
        defaults: { ...defaults, calendarKey: '' },
        taskLists,
        timeZone: TZ,
      }),
    ).toMatchObject({ index: 1, reason: 'A title and calendar are required.' });
  });
});

describe('todoPrefillError', () => {
  const reminders = { listKey: 'apple-reminders:groceries', provider: 'apple' as const };
  it('checks what the form’s Save checks, the Reminders-only fields only on a Reminders list', () => {
    expect(todoPrefillError(todo('Milk').prefill, reminders)).toBeUndefined();
    expect(todoPrefillError({ date: '', title: 'Milk' }, reminders)).toBe(
      'A due date is required.',
    );
    // Undated: the placeholder day is not checked.
    expect(
      todoPrefillError(
        { date: '', title: 'Milk' },
        { ...reminders, extras: held({ undated: true }) },
      ),
    ).toBeUndefined();
    expect(todoPrefillError(todo('Milk', '9:5').prefill, reminders)).toBe(
      'The due time must be HH:MM.',
    );
    const badUrl = held({ reminder: { alarms: [], url: 'not a url' } });
    expect(todoPrefillError(todo('Milk').prefill, { ...reminders, extras: badUrl })).toBe(
      'The URL is not valid.',
    );
    expect(
      todoPrefillError(todo('Milk').prefill, {
        extras: badUrl,
        listKey: 'acc:inbox',
        provider: 'google',
      }),
    ).toBeUndefined();
    expect(
      todoPrefillError(todo('Milk').prefill, {
        ...reminders,
        extras: held({
          reminder: {
            alarms: [],
            recurrence: { freq: 'weekly', interval: 1, untilDate: '2026-08-01' },
            url: '',
          },
        }),
      }),
    ).toBe('The repeat must end on or after its first day.');
  });
});

describe('taskFromPrefill', () => {
  const extras = held({
    reminder: {
      alarms: [0, -60],
      priority: 'low',
      recurrence: { freq: 'daily', interval: 2 },
      url: ' https://example.com/list ',
    },
    taskNotes: 'two cartons',
  });

  it('writes a reminder with its own time and Reminders-only fields', () => {
    expect(
      taskFromPrefill(todo('Milk', '08:00').prefill, {
        extras,
        listKey: 'apple-reminders:groceries',
        provider: 'apple',
      }),
    ).toEqual({
      accountId: 'apple-reminders',
      alarms: [0, -60],
      dueDate: '2026-08-29',
      dueTime: '08:00',
      notes: 'two cartons',
      priority: 'low',
      recurrence: { freq: 'daily', interval: 2 },
      taskListId: 'groceries',
      title: 'Milk',
      url: 'https://example.com/list',
    });
  });

  it('writes a Google task date-only, the link in its notes; an undated one without a day', () => {
    expect(
      taskFromPrefill(todo('Milk', '08:00').prefill, {
        extras: { ...extras, undated: true },
        listKey: 'acc:inbox',
        provider: 'google',
      }),
    ).toEqual({
      accountId: 'acc',
      notes: 'two cartons\n\nhttps://example.com/list',
      taskListId: 'inbox',
      title: 'Milk',
    });
  });
});
