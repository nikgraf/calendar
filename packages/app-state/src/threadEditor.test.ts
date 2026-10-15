import { CalendarInfo } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import { startThread } from './draftThread.ts';
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
    expect(previews.map((preview) => preview.candidate?.startTime)).toEqual([undefined, '09:00']);
    expect(threadPreviews(state.drafts, 0, todo, context)).toEqual([]);
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
});
