import { describe, expect, it } from 'vite-plus/test';
import { foldForm, refineThread, startThread, stepTo, threadLine } from './draftThread.ts';
import type { QuickAddItem } from './quickAddItem.ts';
import { lineChanges, shownMarks, stepName, stepSource } from './threadSteps.ts';

const lunch: QuickAddItem = {
  kind: 'event',
  prefill: {
    date: '2026-08-28',
    endTime: '14:00',
    isAllDay: false,
    startTime: '13:00',
    title: 'Lunch with Sarah',
  },
};
const earlier: QuickAddItem = {
  kind: 'event',
  prefill: { ...lunch.prefill, endTime: '13:30', startTime: '12:30' },
};
const placed: QuickAddItem = {
  kind: 'event',
  prefill: { ...earlier.prefill, location: 'Figlmüller, Wollzeile 5' },
};
const standup: QuickAddItem = {
  kind: 'event',
  prefill: {
    date: '2026-08-31',
    endTime: '09:15',
    isAllDay: false,
    startTime: '09:00',
    title: 'Standup',
  },
};

const ids = () => {
  let count = 0;
  return () => {
    count += 1;
    return `d${String(count)}`;
  };
};

/** A phrase, a change by phrase, then a place typed by hand. */
const story = () => {
  const id = ids();
  const started = startThread([lunch], 'Lunch with Sarah tomorrow at one', { id });
  const moved = refineThread(
    started,
    'make it half past twelve',
    [{ id: 'd1', item: earlier }],
    id,
  );
  return foldForm(moved, { item: placed }, { kind: 'edit' }, id);
};

describe('lineChanges', () => {
  it('says what each step did to the draft the form showed', () => {
    const [made, moved, typed] = threadLine(story());
    expect(lineChanges(made!).map((change) => change.field)).toEqual(['title', 'date', 'time']);
    expect(lineChanges(moved!)).toEqual([
      { field: 'time', from: '13:00–14:00', to: '12:30–13:30' },
    ]);
    expect(lineChanges(typed!)).toEqual([
      { field: 'location', from: undefined, to: 'Figlmüller, Wollzeile 5' },
    ]);
  });

  it('reads a draft the step left alone as unchanged, and one it does not hold as nothing', () => {
    const id = ids();
    const two = startThread([lunch, standup], 'From your paste', { id });
    const moved = refineThread(two, 'half past twelve', [{ id: 'd1', item: earlier }], id);
    const line = threadLine(moved)[1]!;
    expect(lineChanges(line, 'd2')).toEqual([]);
    expect(lineChanges(line, 'd1')).toHaveLength(1);
    expect(lineChanges(line, 'gone')).toEqual([]);
  });
});

describe('shownMarks', () => {
  it('marks what the newest phrase changed, under its id', () => {
    const id = ids();
    const started = startThread([lunch], 'x', { id });
    const moved = refineThread(started, 'half past twelve', [{ id: 'd1', item: earlier }], id);
    const marks = shownMarks(moved);
    expect([...(marks?.fields ?? [])]).toEqual(['time']);
    expect(marks?.key).toBe(moved.steps.at(-1)?.id);
    expect(marks?.changes).toEqual([{ field: 'time', from: '13:00–14:00', to: '12:30–13:30' }]);
  });

  it('marks nothing before the first step, nor under the hand that is editing', () => {
    expect(shownMarks(startThread([], 'x'))?.changes ?? []).toEqual([]);
    expect(shownMarks(stepTo(story(), 0))).toBeNull();
    // The newest step is the edit made by hand just now.
    expect(shownMarks(story())).toBeNull();
  });

  it('marks an edit by hand like any other step once it is an older one on show', () => {
    const id = ids();
    const edited = story();
    const again = refineThread(
      edited,
      'call it Team lunch',
      [{ id: 'd1', item: { kind: 'event', prefill: { ...placed.prefill, title: 'Team lunch' } } }],
      id,
    );
    expect([...(shownMarks(again)?.fields ?? [])]).toEqual(['title']);
    expect([...(shownMarks(stepTo(again, 3))?.fields ?? [])]).toEqual(['location']);
    expect([...(shownMarks(stepTo(again, 2))?.fields ?? [])]).toEqual(['time']);
  });
});

describe('stepName and stepSource', () => {
  it('names a step in one line', () => {
    const [made, , typed] = threadLine(story());
    expect(stepName(made!)).toBe('“Lunch with Sarah tomorrow at one”');
    expect(stepSource(made!)).toBe('Said');
    expect(stepName(typed!)).toBe('Place');
    expect(stepSource(typed!)).toBe('By hand');
    const id = ids();
    const picked = foldForm(
      startThread([lunch], 'x', { id }),
      { item: placed },
      { kind: 'pick', pick: 'place' },
      id,
    );
    expect(stepName(threadLine(picked)[1]!)).toBe('Place picked');
  });
});
