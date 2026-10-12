import { describe, expect, it } from 'vite-plus/test';
import { focusDraft, startThread } from './draftThread.ts';
import type { QuickAddItem } from './quickAddItem.ts';
import { firstUnwritableDraft, threadPreviews } from './threadEditor.ts';

const TZ = 'Europe/Vienna';
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
    const previews = threadPreviews(state.drafts, state.focused, live, {
      color: '#123456',
      timeZone: TZ,
    });
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
    const previews = threadPreviews(state.drafts, 0, dinner, { color: '#123456', timeZone: TZ });
    expect(previews.map((preview) => preview.candidate?.startTime)).toEqual([undefined, '09:00']);
    expect(threadPreviews(state.drafts, 0, todo, { color: '#123456', timeZone: TZ })).toEqual([]);
  });
});

describe('firstUnwritableDraft', () => {
  it('finds the first draft beside the focused one Save would refuse, with the reason', () => {
    const state = focusDraft(
      startThread(
        [
          event('Ok', '2026-08-28', '09:00', '10:00'),
          event('Backwards', '2026-08-28', '11:00', '10:00'),
          todo,
        ],
        'x',
        { id: ids() },
      ),
      0,
    );
    expect(firstUnwritableDraft(state, { calendarKey: 'acc:cal', timeZone: TZ })).toMatchObject({
      index: 1,
    });
    expect(
      firstUnwritableDraft(focusDraft(state, 1), { calendarKey: 'acc:cal', timeZone: TZ }),
    ).toBeUndefined();
  });
});
