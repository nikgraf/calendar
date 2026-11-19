import {
  BirthdayOccurrence,
  BirthdayRecord,
  EventRecord,
  TaskRecord,
  Temporal,
} from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import {
  cancelEditor,
  captureMayOpen,
  closeDeleted,
  closeEditor,
  closeTaskDetail,
  inRoute,
  NONE,
  routeDismissed,
  type RouteSheet,
  type Sheet,
  routeKey,
  routeMove,
} from './sheets.ts';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const start = Date.parse('2026-10-05T09:00:00Z');
const day = Temporal.PlainDate.from('2026-10-05');

const event = (overrides: Partial<EventRecord> = {}): EventRecord =>
  new EventRecord({
    accountId: 'apple-calendar',
    calendarId: 'home',
    endUtc: start + HOUR,
    etag: null,
    id: 'dentist',
    isAllDay: false,
    startTimeZone: 'UTC',
    startUtc: start,
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: 'Dentist',
    updatedAt: 0,
    ...overrides,
  });

/** An occurrence of the weekly series `standup`, `week` weeks after `start`. */
const occurrence = (week: number, overrides: Partial<EventRecord> = {}) =>
  event({
    id: `standup__${String(week)}`,
    originalStartUtc: start + week * 7 * DAY,
    recurringEventId: 'standup',
    startUtc: start + week * 7 * DAY,
    title: 'Standup',
    ...overrides,
  });

/** The editor on a new item ("+", a slot drawn on the grid, a capture's thread). */
const newItem = (opening: number): RouteSheet => ({
  kind: 'edit',
  opening,
  seed: { initialDate: day },
});
/** The editor on an existing event, opened elsewhere than its detail (a notification's task, a capture). */
const editing = (opening: number, edited: EventRecord): RouteSheet => ({
  kind: 'edit',
  opening,
  seed: { event: edited, initialDate: day },
});
/** The editor the detail's Edit or Convert turned the detail into. */
const fromDetail = (opening: number, edited: EventRecord): RouteSheet => ({
  backTo: { event: edited, kind: 'detail' },
  kind: 'edit',
  opening,
  seed: { event: edited, initialDate: day },
});
const detail = (shown: EventRecord): RouteSheet => ({ event: shown, kind: 'detail' });
const task = (overrides: Partial<TaskRecord> = {}) =>
  new TaskRecord({
    accountId: 'account',
    id: 'task',
    listId: 'list',
    provider: 'google',
    status: 'needsAction',
    title: 'Call Alex',
    updatedAt: 0,
    ...overrides,
  });
const taskDetail = (shown: TaskRecord): Extract<RouteSheet, { kind: 'task-detail' }> => ({
  kind: 'task-detail',
  task: shown,
});
const birthday: Sheet = {
  birthday: new BirthdayOccurrence({
    date: '2026-10-05',
    record: new BirthdayRecord({ day: 5, displayName: 'Mara', id: 'mara', month: 10, sources: [] }),
  }),
  kind: 'birthday',
};

// The host applies each close to the sheet as it is when the write's
// reply lands (a functional `setSheet`), which may be a later one.
describe('closeEditor', () => {
  it('closes its own editor once the write answers', () => {
    expect(closeEditor(1)(newItem(1))).toBe(NONE);
    expect(closeEditor(2)(editing(2, event()))).toBe(NONE);
  });

  it('leaves the detail of an event opened while it saved', () => {
    const tapped = detail(event({ id: 'lunch', title: 'Lunch' }));
    expect(closeEditor(1)(tapped)).toBe(tapped);
  });

  it('leaves an editor opened meanwhile while it saved', () => {
    const drawn = newItem(2);
    expect(closeEditor(1)(drawn)).toBe(drawn);
  });

  it('leaves what was opened after a swipe down mid-save, and an editor reopened on the event', () => {
    const reopened = editing(3, event());
    expect(closeEditor(2)(reopened)).toBe(reopened);
    expect(closeEditor(2)(NONE)).toBe(NONE);
  });

  it('closes the whole sheet on a save from the editor the detail turned into', () => {
    expect(closeEditor(4)(fromDetail(4, event()))).toBe(NONE);
  });
});

// Cancel is applied the same way, to the sheet as it is when it is pressed.
describe('cancelEditor', () => {
  it('returns a task or reminder editor to the detail of the latest row it opened', () => {
    for (const provider of ['google', 'apple'] as const) {
      const shown = task({ provider, title: 'Call Alex (updated)' });
      const back = taskDetail(shown);
      const editor: RouteSheet = {
        ...newItem(1),
        backTo: back,
        kind: 'edit',
        opening: 1,
        seed: { initialDate: day },
        task: shown,
      };
      expect(cancelEditor(1)(editor)).toBe(back);
      expect(closeEditor(1)(back)).toBe(back);
    }
  });
  it('turns the editor back into the detail its Edit or Convert came from', () => {
    expect(cancelEditor(1)(fromDetail(1, event({ title: 'Dentist (moved)' })))).toEqual(
      detail(event({ title: 'Dentist (moved)' })),
    );
  });

  it('closes an editor opened anywhere else', () => {
    expect(cancelEditor(1)(newItem(1))).toBe(NONE);
    expect(cancelEditor(2)(editing(2, event()))).toBe(NONE);
  });

  it('leaves what was opened since: another editor, a detail, nothing', () => {
    const drawn = newItem(2);
    const tapped = detail(event({ id: 'lunch', title: 'Lunch' }));
    expect(cancelEditor(1)(drawn)).toBe(drawn);
    expect(cancelEditor(1)(tapped)).toBe(tapped);
    expect(cancelEditor(1)(NONE)).toBe(NONE);
  });
  it("leaves the detail it went back to when the editor's save answers after", () => {
    const back = cancelEditor(3)(fromDetail(3, event()));
    expect(closeEditor(3)(back)).toBe(back);
  });
});

// The host pushes the editor route for these and pops it for the rest.
describe('inRoute', () => {
  it('holds the detail and the editor, not the page sheets or nothing', () => {
    expect(
      [detail(event()), taskDetail(task()), newItem(1), fromDetail(2, event())].every(inRoute),
    ).toBe(true);
    expect([NONE, birthday].some(inRoute)).toBe(false);
  });
});

// The host's push/pop effect asks on every change of the sheet, and again
// once the route's old sheet has gone.
describe('routeMove', () => {
  const up = { leaving: false, presented: true };
  const down = { leaving: false, presented: false };
  const going = { leaving: true, presented: false };

  it('pushes the route for a detail or an editor, and pops it for anything else', () => {
    expect(routeMove(detail(event()), down)).toBe('push');
    expect(routeMove(newItem(1), down)).toBe('push');
    expect(routeMove(NONE, up)).toBe('pop');
    expect(routeMove(birthday, up)).toBe('pop');
  });

  it('only swaps the content between a detail and its editor', () => {
    expect(routeMove(fromDetail(2, event()), up)).toBe('stay');
    expect(routeMove(detail(event()), up)).toBe('stay');
  });

  it("waits with a reminder's detail asked for while the old sheet is still leaving", () => {
    expect(routeMove(detail(event({ id: 'lunch', title: 'Lunch' })), going)).toBe('wait');
    expect(routeMove(NONE, going)).toBe('stay');
  });
});

// The old route's dismissal is applied to the sheet as it is by then.
describe('routeDismissed', () => {
  it('closes the detail or editor a swipe down took away', () => {
    expect(routeDismissed(true)(detail(event()))).toBe(NONE);
    expect(routeDismissed(true)(fromDetail(3, event()))).toBe(NONE);
  });

  it("keeps what was asked for after the host's own pop, and a page sheet either way", () => {
    const tapped = detail(event({ id: 'lunch', title: 'Lunch' }));
    expect(routeDismissed(false)(tapped)).toBe(tapped);
    expect(routeDismissed(true)(birthday)).toBe(birthday);
  });
});

// The route's content is keyed by it: a new key cross-fades, the same one stays put.
describe('routeKey', () => {
  it('keeps a task detail across edits and completion, distinct across accounts, lists and events', () => {
    const shown = taskDetail(task());
    expect(routeKey(taskDetail(task({ status: 'completed', title: 'Changed' })))).toBe(
      routeKey(shown),
    );
    const keys = [
      shown,
      taskDetail(task({ accountId: 'other' })),
      taskDetail(task({ listId: 'other' })),
      detail(event({ id: 'task' })),
    ].map(routeKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(routeMove(shown, { leaving: false, presented: false })).toBe('push');
    expect(routeDismissed(true)(shown)).toBe(NONE);
    expect(captureMayOpen(shown, { formSheetGone: true, settingsOpen: false })).toBe(false);
  });
  it('keeps a detail on a refreshed row of its event, also an occurrence edited since under a new id', () => {
    expect(routeKey(detail(event({ title: 'Dentist (moved)' })))).toBe(routeKey(detail(event())));
    expect(routeKey(detail(occurrence(1, { id: 'standup-exception' })))).toBe(
      routeKey(detail(occurrence(1))),
    );
  });

  it('tells a detail from the editor it turns into, another event, and one opening from the next', () => {
    const keys = [
      routeKey(detail(event())),
      routeKey(detail(event({ id: 'lunch', title: 'Lunch' }))),
      routeKey(fromDetail(1, event())),
      routeKey(fromDetail(2, event())),
    ];
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('closeTaskDetail', () => {
  it('keeps a newer editor or reopened detail when completion answers late', () => {
    const opened = taskDetail(task());
    const editor: RouteSheet = {
      kind: 'edit',
      opening: 2,
      seed: { initialDate: day },
      task: task(),
    };
    const reopened = taskDetail(task());
    expect(closeTaskDetail(task(), 'complete', opened)(editor)).toBe(editor);
    expect(closeTaskDetail(task(), 'complete', opened)(reopened)).toBe(reopened);
    expect(closeTaskDetail(task(), 'complete', opened)(opened)).toBe(NONE);
  });

  it('closes its own detail after id promotion and a reminder list move', () => {
    const opened = taskDetail(task({ id: 'local-1', listId: 'old-list' }));
    for (const action of ['complete', 'delete'] as const) {
      expect(closeTaskDetail(task(), action, opened)(opened)).toBe(NONE);
    }
  });

  it('closes only the task deleted, also in its editor', () => {
    const opened = taskDetail(task());
    const close = closeTaskDetail(task(), 'delete', opened);
    expect(close(taskDetail(task({ title: 'New title' })))).toBe(NONE);
    expect(
      close({
        kind: 'edit',
        opening: 1,
        seed: { initialDate: day },
        task: task(),
      }),
    ).toBe(NONE);
    for (const other of [
      taskDetail(task({ id: 'other' })),
      taskDetail(task({ accountId: 'other' })),
      taskDetail(task({ listId: 'other' })),
      newItem(2),
      detail(event()),
      birthday,
    ]) {
      expect(close(other)).toBe(other);
    }
  });
});

describe('closeDeleted', () => {
  it('closes the detail of the event it deleted, also as a refreshed row of it', () => {
    expect(closeDeleted(event(), 'instance')(detail(event()))).toBe(NONE);
    expect(closeDeleted(event(), 'instance')(detail(event({ title: 'Dentist (moved)' })))).toBe(
      NONE,
    );
  });

  it('closes the detail of an occurrence edited on its own since, under a new id', () => {
    const exception = detail(occurrence(1, { id: 'standup-exception', title: 'Standup (late)' }));
    expect(closeDeleted(occurrence(1), 'instance')(exception)).toBe(NONE);
  });

  it('closes an editor that Edit or Convert opened on the event while it deleted', () => {
    expect(closeDeleted(event(), 'instance')(editing(4, event()))).toBe(NONE);
    expect(closeDeleted(event(), 'instance')(fromDetail(5, event()))).toBe(NONE);
  });

  it('leaves the detail of another event opened after the sheet was swiped away mid-delete', () => {
    const other = detail(event({ id: 'lunch', title: 'Lunch' }));
    expect(closeDeleted(event(), 'instance')(other)).toBe(other);
  });

  it('leaves an editor on a new item or another event, and a birthday', () => {
    const fresh = newItem(5);
    const another = editing(6, event({ id: 'lunch', title: 'Lunch' }));
    expect(closeDeleted(event(), 'instance')(fresh)).toBe(fresh);
    expect(closeDeleted(event(), 'instance')(another)).toBe(another);
    expect(closeDeleted(event(), 'series')(birthday)).toBe(birthday);
  });

  it("closes a sibling occurrence's sheet by the delete's scope", () => {
    const sibling = detail(occurrence(2));
    expect(closeDeleted(occurrence(1), 'instance')(sibling)).toBe(sibling);
    expect(closeDeleted(occurrence(1), 'following')(sibling)).toBe(NONE);
    expect(closeDeleted(occurrence(1), 'series')(editing(7, occurrence(0)))).toBe(NONE);
  });
});

// The host asks on every render while a finished capture's thread is held.
describe('captureMayOpen', () => {
  const calendar = { formSheetGone: true, settingsOpen: false };

  it('opens at once when nothing is up', () => {
    expect(captureMayOpen(NONE, calendar)).toBe(true);
  });

  it('waits while an editor the user opened during the run is up', () => {
    expect(captureMayOpen(newItem(1), calendar)).toBe(false);
    expect(captureMayOpen(editing(2, event()), calendar)).toBe(false);
  });

  it("waits until that editor's form sheet is gone after it closed", () => {
    expect(captureMayOpen(NONE, { ...calendar, formSheetGone: false })).toBe(false);
  });

  it('waits for a detail or a birthday, also one tapped behind the closing editor', () => {
    expect(captureMayOpen(detail(event({ id: 'lunch', title: 'Lunch' })), calendar)).toBe(false);
    expect(captureMayOpen(birthday, calendar)).toBe(false);
  });

  it('waits while Settings is open, the avatar tapped from the editor included', () => {
    expect(captureMayOpen(NONE, { ...calendar, settingsOpen: true })).toBe(false);
  });
});
