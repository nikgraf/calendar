import { CalendarInfo } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import { openThread, startThread } from './draftThread.ts';
import type { QuickAddItem } from './quickAddItem.ts';
import { reportingEdits, threadPreviews } from './threadEditor.ts';

const TZ = 'Europe/Vienna';
const calendar = (id: string, colorHex: string) =>
  new CalendarInfo({
    accessRole: 'owner',
    accountId: 'acc',
    colorHex,
    id,
    isPrimary: false,
    isVisible: true,
    provider: 'google',
    summary: id,
    timeZone: TZ,
  });
const calendars = [calendar('work', '#123456'), calendar('home', '#654321')];
const context = { calendarKey: 'acc:work', calendars, timeZone: TZ };
const event = (title: string, date: string, startTime: string, endTime: string): QuickAddItem => ({
  kind: 'event',
  prefill: { date, endTime, isAllDay: false, startTime, title },
});
const todo: QuickAddItem = {
  kind: 'task',
  prefill: { date: '2026-08-28', title: 'Call the bank' },
};

const ids = () => {
  let count = 0;
  return () => {
    count += 1;
    return `d${String(count)}`;
  };
};

/** What is drawn, in short: its kind, where and whether it is the focused one. */
const kinds = (previews: ReturnType<typeof threadPreviews>) =>
  previews.map((preview) => [preview.kind, preview.date, preview.startTime, preview.focused]);

describe('threadPreviews', () => {
  const dinner = event('Dinner', '2026-08-28', '19:00', '20:00');
  const lunch = event('Lunch', '2026-08-29', '12:00', '13:00');

  it('draws the focused draft from the live form, the others as the thread holds them, a to-do not at all', () => {
    const state = startThread([dinner, lunch, todo], 'x', { id: ids() });
    const live = event('Dinner with Teo', '2026-08-28', '20:00', '21:00');
    const previews = threadPreviews(state.drafts, state.focused, live, context);
    expect(
      previews.map((preview) => [preview.id, preview.title, preview.startTime, preview.focused]),
    ).toEqual([
      ['d1', 'Dinner with Teo', '20:00', true],
      ['d2', 'Lunch', '12:00', false],
    ]);
    expect(previews.every((preview) => preview.color === '#123456')).toBe(true);
  });

  it('adds the free slots beside the focused draft as candidates; a focused to-do draws nothing', () => {
    const slots = [
      { date: '2026-08-28', endTime: '20:00', startTime: '19:00' },
      { date: '2026-08-29', endTime: '10:00', startTime: '09:00' },
    ];
    const state = startThread([dinner], 'x', { id: ids(), slots });
    const previews = threadPreviews(state.drafts, 0, dinner, context);
    expect(
      previews.map((preview) =>
        preview.kind === 'candidate' ? preview.slot.startTime : preview.kind,
      ),
    ).toEqual(['draft', '09:00']);
    expect(threadPreviews(state.drafts, 0, todo, context)).toEqual([]);
  });

  it('leaves a saved event to its own block until its draft is somewhere else', () => {
    const state = openThread({ item: dinner }, ids());
    const saved = { instance: false, opened: dinner };
    // Where it was saved: the calendar already draws it.
    expect(threadPreviews(state.drafts, 0, dinner, { ...context, saved })).toEqual([]);
    // A title edit moves nothing on the calendar.
    expect(
      threadPreviews(state.drafts, 0, event('Late dinner', '2026-08-28', '19:00', '20:00'), {
        ...context,
        saved,
      }),
    ).toEqual([]);
    // Moved: the draft is drawn where it would go, the event's block showing where it was.
    const moved = event('Dinner', '2026-08-28', '20:00', '21:00');
    expect(
      threadPreviews(state.drafts, 0, moved, { ...context, saved }).map((preview) => [
        preview.startTime,
        preview.focused,
      ]),
    ).toEqual([['20:00', true]]);
  });

  it('outlines where the step on show moved the focused draft from', () => {
    const state = startThread([dinner], 'x', { id: ids() });
    const before = state.drafts[0]!;
    const moved = event('Dinner', '2026-08-29', '20:00', '21:00');
    expect(
      kinds(threadPreviews(state.drafts, 0, moved, { ...context, movedFrom: before })),
    ).toEqual([
      ['draft', '2026-08-29', '20:00', true],
      ['was', '2026-08-28', '19:00', false],
    ]);
    // The form back where it stood: nothing to outline.
    expect(
      kinds(threadPreviews(state.drafts, 0, dinner, { ...context, movedFrom: before })),
    ).toEqual([['draft', '2026-08-28', '19:00', true]]);
    // A to-do drew no block, so it leaves no trace.
    expect(
      kinds(
        threadPreviews(state.drafts, 0, moved, {
          ...context,
          movedFrom: { id: before.id, item: todo },
        }),
      ),
    ).toEqual([['draft', '2026-08-29', '20:00', true]]);
  });

  it('leaves a saved event’s own block to be its trace, and outlines a later step’s', () => {
    const state = openThread({ item: dinner }, ids());
    const saved = { instance: false, opened: dinner };
    const first = event('Dinner', '2026-08-28', '20:00', '21:00');
    const second = event('Dinner', '2026-08-28', '21:00', '22:00');
    // Moved off where it is saved: the event's block shows where it was.
    expect(
      kinds(
        threadPreviews(state.drafts, 0, first, {
          ...context,
          movedFrom: state.drafts[0],
          saved,
        }),
      ),
    ).toEqual([['draft', '2026-08-28', '20:00', true]]);
    // Moved again: the place between is neither's, so it is outlined.
    expect(
      kinds(
        threadPreviews(state.drafts, 0, second, {
          ...context,
          movedFrom: { id: state.drafts[0]!.id, item: first },
          saved,
        }),
      ),
    ).toEqual([
      ['draft', '2026-08-28', '21:00', true],
      ['was', '2026-08-28', '20:00', false],
    ]);
  });

  it('draws one occurrence of a saved series without the series’ rule', () => {
    const weekly: QuickAddItem = {
      kind: 'event',
      prefill: { ...dinner.prefill, recurrence: { freq: 'weekly' } },
    } as QuickAddItem;
    const moved: QuickAddItem = {
      kind: 'event',
      prefill: { ...weekly.prefill, endTime: '21:00', startTime: '20:00' },
    } as QuickAddItem;
    const state = openThread({ item: weekly }, ids());
    const once = threadPreviews(state.drafts, 0, moved, {
      ...context,
      saved: { instance: true, opened: weekly },
    });
    expect(once).toHaveLength(1);
    expect(once[0]).not.toHaveProperty('recurrence');
    const all = threadPreviews(state.drafts, 0, moved, {
      ...context,
      saved: { instance: false, opened: weekly },
    });
    expect(all[0]?.recurrence).toBeDefined();
  });

  it('draws each draft in the color of the calendar it goes to: its own, else the form’s', () => {
    const state = startThread(
      [dinner, lunch, event('Brunch', '2026-08-30', '11:00', '12:00')],
      'x',
      {
        id: ids(),
      },
    );
    const extras = { attendees: [], description: '', reminders: undefined };
    const drafts = state.drafts.map((draft, index) =>
      index === 1 ? { ...draft, extras: { ...extras, calendarKey: 'acc:home' } } : draft,
    );
    expect(
      threadPreviews(drafts, 0, dinner, { ...context, calendarKey: 'acc:home' }).map((preview) => [
        preview.id,
        preview.color,
      ]),
    ).toEqual([
      ['d1', '#654321'],
      ['d2', '#654321'],
      ['d3', '#654321'],
    ]);
    expect(threadPreviews(drafts, 0, dinner, context).map((preview) => preview.color)).toEqual([
      '#123456',
      '#654321',
      '#123456',
    ]);
  });
});

describe('reportingEdits', () => {
  it('reports the listed calls before making them, and leaves everything else alone', () => {
    const calls: Array<string> = [];
    const model = {
      applyPrefill: (title: string) => calls.push(`prefill ${title}`),
      clearDueDate: undefined as (() => void) | undefined,
      setTitle: (title: string) => calls.push(`title ${title}`),
      title: 'Lunch',
    };
    const reporting = reportingEdits(model, ['clearDueDate', 'setTitle'], () => calls.push('edit'));

    reporting.setTitle('Dinner');
    reporting.applyPrefill('Brunch');
    expect(calls).toEqual(['edit', 'title Dinner', 'prefill Brunch']);
    expect(reporting.title).toBe('Lunch');
    // A setter the model does not offer here stays absent.
    expect(reporting.clearDueDate).toBeUndefined();
  });

  it('reports a call that answers later a second time, once it has, refused or not', async () => {
    const calls: Array<string> = [];
    const model = {
      pickPlace: async (name: string) => {
        calls.push(`pick ${name}`);
        await Promise.resolve();
        calls.push('coordinates');
      },
      switchTo: async () => {
        await Promise.resolve();
        throw new Error('declined');
      },
    };
    const reporting = reportingEdits(model, ['pickPlace', 'switchTo'], () => calls.push('edit'));

    await reporting.pickPlace('Café');
    // The second report follows the answer: the form holds the coordinates by then.
    await Promise.resolve();
    expect(calls).toEqual(['edit', 'pick Café', 'coordinates', 'edit']);

    calls.length = 0;
    await expect(reporting.switchTo()).rejects.toThrow('declined');
    await Promise.resolve();
    expect(calls).toEqual(['edit', 'edit']);
  });
});
