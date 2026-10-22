import { BirthdayOccurrence, BirthdayRecord, EventRecord, Temporal } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import { captureMayOpen, closeDeleted, closeEditor, NONE, type Sheet } from './sheets.ts';

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

/** The editor on a new item ("+", a slot drawn on the grid, a capture's thread): half height. */
const newItem = (opening: number): Sheet => ({ kind: 'edit', opening, seed: { initialDate: day } });
/** The editor on an existing event: the detail's Edit, or its Convert. */
const editing = (opening: number, edited: EventRecord): Sheet => ({
  kind: 'edit',
  opening,
  seed: { event: edited, initialDate: day },
});
const detail = (shown: EventRecord): Sheet => ({ event: shown, kind: 'detail' });
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

  it('leaves the detail of an event tapped behind a half-height editor while it saved', () => {
    const tapped = detail(event({ id: 'lunch', title: 'Lunch' }));
    expect(closeEditor(1)(tapped)).toBe(tapped);
  });

  it('leaves the editor a slot drawn behind it opened while it saved', () => {
    const drawn = newItem(2);
    expect(closeEditor(1)(drawn)).toBe(drawn);
  });

  it('leaves what was opened after a swipe down mid-save, and an editor reopened on the event', () => {
    const reopened = editing(3, event());
    expect(closeEditor(2)(reopened)).toBe(reopened);
    expect(closeEditor(2)(NONE)).toBe(NONE);
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
