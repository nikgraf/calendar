import { describe, expect, it } from 'vite-plus/test';
import { Attendee, EventRecord, EventReminders, PendingOp, TaskRecord } from '../types.ts';
import { pendingOpDiff } from './pendingChange.ts';

const TZ = 'Europe/Vienna';

const event = (overrides: Partial<EventRecord> = {}) =>
  new EventRecord({
    accountId: 'a',
    calendarId: 'c',
    // 09:00–10:00 Vienna (UTC+2 in September).
    endUtc: Date.parse('2026-09-22T08:00:00Z'),
    etag: null,
    id: 'e1',
    isAllDay: false,
    startUtc: Date.parse('2026-09-22T07:00:00Z'),
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'pending',
    title: 'Standup',
    updatedAt: 0,
    ...overrides,
  });

const op = (overrides: Partial<PendingOp> & Pick<PendingOp, 'kind'>) =>
  new PendingOp({
    accountId: 'a',
    attempts: 0,
    calendarId: 'c',
    createdAt: 0,
    eventId: 'e1',
    id: 'op',
    nextAttemptAt: 0,
    ...overrides,
  });

const task = (overrides: Partial<TaskRecord> = {}) =>
  new TaskRecord({
    accountId: 'a',
    dueDate: '2026-08-30',
    id: 't1',
    listId: 'l1',
    provider: 'google',
    status: 'needsAction',
    title: 'Pay rent',
    updatedAt: 0,
    ...overrides,
  });

/** An invitation with the user's own attendee answering `responseStatus`. */
const self = (responseStatus: Attendee['responseStatus']) =>
  event({
    attendees: [
      new Attendee({ email: 'me@example.com', isSelf: true, responseStatus }),
      new Attendee({ email: 'ann@example.com', responseStatus: 'accepted' }),
    ],
  });

const taskOp = (overrides: Partial<PendingOp> & Pick<PendingOp, 'kind'>) =>
  op({ calendarId: 'l1', eventId: 't1', taskListId: 'l1', ...overrides });

const context = {
  calendarName: (_accountId: string, calendarId: string) => ({ c: 'Work', d: 'Home' })[calendarId],
  timeZone: TZ,
};

describe('pendingOpDiff', () => {
  it('lists what an edit changed, as displayed', () => {
    const diff = pendingOpDiff(
      op({
        beforePayload: event(),
        kind: 'update',
        payload: event({ location: 'Room 4', title: 'Standup (moved)' }),
      }),
      context,
    );
    expect(diff).toEqual([
      { after: 'Standup (moved)', before: 'Standup', label: 'Title' },
      { after: 'Room 4', before: 'none', label: 'Location' },
    ]);
  });

  it('is undefined for an edit queued before the snapshot', () => {
    expect(pendingOpDiff(op({ kind: 'update', payload: event() }), context)).toBeUndefined();
    expect(pendingOpDiff(op({ kind: 'rsvp', payload: event() }), context)).toBeUndefined();
  });

  it('lists the fields a create sets and skips the unset ones', () => {
    const diff = pendingOpDiff(
      op({
        kind: 'create',
        payload: event({
          attendees: [new Attendee({ email: 'ann@example.com', responseStatus: 'needsAction' })],
          location: 'Room 4',
        }),
      }),
      context,
    );
    expect(diff).toEqual([
      { after: 'Standup', before: null, label: 'Title' },
      { after: 'Tue, Sep 22, 9:00 AM – 10:00 AM', before: null, label: 'Time' },
      { after: 'Room 4', before: null, label: 'Location' },
      { after: 'ann@example.com', before: null, label: 'Guests' },
    ]);
  });

  it('names what a delete removes, also from an occurrence tombstone', () => {
    const named = [
      { after: null, before: 'Standup', label: 'Title' },
      { after: null, before: 'Tue, Sep 22, 9:00 AM – 10:00 AM', label: 'Time' },
    ];
    expect(
      pendingOpDiff(op({ beforePayload: event(), kind: 'delete', payload: event() }), context),
    ).toEqual(named);
    // An occurrence that had no override: the tombstone is all there is.
    expect(
      pendingOpDiff(
        op({ beforePayload: null, kind: 'delete', payload: event({ status: 'cancelled' }) }),
        context,
      ),
    ).toEqual(named);
  });

  it('shows an RSVP as the own response', () => {
    expect(
      pendingOpDiff(
        op({ beforePayload: self('needsAction'), kind: 'rsvp', payload: self('accepted') }),
        context,
      ),
    ).toEqual([{ after: 'Accepted', before: 'No response', label: 'Response' }]);
  });

  it('describes repeat rules, reminders, free/busy and visibility', () => {
    const diff = pendingOpDiff(
      op({
        beforePayload: event(),
        kind: 'update',
        payload: event({
          recurrence: ['RRULE:FREQ=DAILY;COUNT=3'],
          reminders: new EventReminders({
            overrides: [{ method: 'popup', minutes: 10 }],
            useDefault: false,
          }),
          transparency: 'transparent',
          visibility: 'private',
        }),
      }),
      context,
    );
    expect(diff).toEqual([
      { after: 'Daily, 3 times', before: 'Does not repeat', label: 'Repeat' },
      { after: '10 minutes before', before: 'Calendar default', label: 'Reminders' },
      { after: 'Free', before: 'Busy', label: 'Shown as' },
      { after: 'Private', before: 'Default', label: 'Visibility' },
    ]);
  });

  it('names a move by its calendars, falling back to ids', () => {
    expect(pendingOpDiff(op({ kind: 'move', targetCalendarId: 'd' }), context)).toEqual([
      { after: 'Home', before: 'Work', label: 'Calendar' },
    ]);
    expect(pendingOpDiff(op({ kind: 'move', targetCalendarId: 'x' }), context)).toEqual([
      { after: 'x', before: 'Work', label: 'Calendar' },
    ]);
  });

  it('shows a calendar color change', () => {
    expect(
      pendingOpDiff(
        op({ beforeColorHex: '#00ff00', colorHex: '#ff0000', kind: 'calendarColor' }),
        context,
      ),
    ).toEqual([{ after: '#ff0000', before: '#00ff00', label: 'Color' }]);
  });

  it('describes task ops from their snapshot and the fields they carry', () => {
    expect(
      pendingOpDiff(
        taskOp({ beforeTask: task(), kind: 'updateTask', taskTitle: 'Pay rent today' }),
        context,
      ),
    ).toEqual([{ after: 'Pay rent today', before: 'Pay rent', label: 'Title' }]);
    expect(
      pendingOpDiff(
        taskOp({ beforeTask: task(), kind: 'completeTask', taskStatus: 'completed' }),
        context,
      ),
    ).toEqual([{ after: 'Completed', before: 'Open', label: 'Status' }]);
    expect(pendingOpDiff(taskOp({ beforeTask: task(), kind: 'deleteTask' }), context)).toEqual([
      { after: null, before: 'Pay rent', label: 'Title' },
      { after: null, before: 'Sun, Aug 30', label: 'Due' },
    ]);
    expect(
      pendingOpDiff(
        taskOp({ kind: 'createTask', taskDue: '2026-08-30', taskTitle: 'Pay rent' }),
        context,
      ),
    ).toEqual([
      { after: 'Pay rent', before: null, label: 'Title' },
      { after: 'Sun, Aug 30', before: null, label: 'Due' },
    ]);
    expect(pendingOpDiff(taskOp({ kind: 'updateTask', taskTitle: 'x' }), context)).toBeUndefined();
  });
});
