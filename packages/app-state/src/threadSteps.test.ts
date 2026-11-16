import { describe, expect, it } from 'vite-plus/test';
import {
  EMPTY_THREAD,
  focusDraft,
  foldForm,
  openThread,
  refineThread,
  startThread,
  stepTo,
  threadLine,
} from './draftThread.ts';
import type { QuickAddItem } from './quickAddItem.ts';
import {
  changedLine,
  lineChanges,
  movedFrom,
  noChangeLines,
  shownMarks,
  stepName,
  stepSource,
  stepSummary,
  versionLabel,
} from './threadSteps.ts';

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

describe('movedFrom', () => {
  it('is the focused draft before the step on show, when that step moved it', () => {
    // At the tip the hand typed a place: no mark, no trace.
    const tip = story();
    expect(movedFrom(tip, shownMarks(tip))).toBeUndefined();
    // One back, the phrase that moved the lunch is on show: it stood at one.
    const back = stepTo(tip, 2);
    expect(movedFrom(back, shownMarks(back))?.item).toEqual(lunch);
    // The step that made the draft moved nothing: there was no draft.
    const first = stepTo(tip, 1);
    expect(movedFrom(first, shownMarks(first))).toBeUndefined();
  });

  it('is nothing for a step that changed other fields only', () => {
    const id = ids();
    const started = startThread([lunch], 'Lunch with Sarah tomorrow at one', { id });
    const renamed = refineThread(
      started,
      'call it team lunch',
      [{ id: 'd1', item: { kind: 'event', prefill: { ...lunch.prefill, title: 'Team lunch' } } }],
      id,
    );
    expect(shownMarks(renamed)?.fields.has('title')).toBe(true);
    expect(movedFrom(renamed, shownMarks(renamed))).toBeUndefined();
  });
});

describe('versionLabel, stepSummary and changedLine', () => {
  it('names a row by the version its step left, and says when a hand made it', () => {
    const [made, moved, typed] = threadLine(story());
    expect([versionLabel(made!), versionLabel(moved!), versionLabel(typed!)]).toEqual([
      'Version 1',
      'Version 2',
      'Version 3 · by hand',
    ]);
  });

  it('gives a phrase its own summary and an edit by hand its fields as they read now', () => {
    const [made, , typed] = threadLine(story());
    expect(stepSummary(made!)).toContain('Lunch with Sarah');
    expect(stepSummary(typed!)).toBe('Place: Figlmüller, Wollzeile 5');
  });

  it('lists what a step changed in a line, and says nothing for none', () => {
    const [, moved] = threadLine(story());
    expect(changedLine(lineChanges(moved!))).toBe('Changed: time');
    expect(changedLine([])).toBe('');
  });
});

/** Stable ids: n1, n2, … in the order they are asked for. */
const noChangeIds = () => {
  let count = 0;
  return () => {
    count += 1;
    return `n${String(count)}`;
  };
};
/** Each position's words, dimmed ones marked. */
const saidAt = (lines: ReturnType<typeof noChangeLines>) =>
  [...lines].map(([position, turns]) => [
    position,
    turns.map(({ dimmed, turn }) => `${turn.utterance}${dimmed ? ' (dimmed)' : ''}`),
  ]);

describe('noChangeLines', () => {
  it('lists words that changed nothing after the step they followed, only the newest undimmed', () => {
    const id = noChangeIds();
    const first = startThread([lunch], 'Lunch with Sarah tomorrow at one', { id });
    const idle = refineThread(first, 'make it at one', [{ id: 'n1', item: lunch }], id);
    expect(saidAt(noChangeLines(idle))).toEqual([[1, ['make it at one']]]);
    const thanks = refineThread(idle, 'thanks', [{ id: 'n1', item: lunch }], id);
    expect(saidAt(noChangeLines(thanks))).toEqual([[1, ['make it at one (dimmed)', 'thanks']]]);
    // A step after them: history, all of it.
    const moved = refineThread(thanks, 'half past twelve', [{ id: 'n1', item: earlier }], id);
    expect(saidAt(noChangeLines(moved))).toEqual([
      [1, ['make it at one (dimmed)', 'thanks (dimmed)']],
    ]);
    // An older step on show dims what was said after the newest.
    const after = refineThread(moved, 'yes', [{ id: 'n1', item: earlier }], id);
    expect(saidAt(noChangeLines(after)).at(-1)).toEqual([2, ['yes']]);
    expect(saidAt(noChangeLines(stepTo(after, 1))).at(-1)).toEqual([2, ['yes (dimmed)']]);
    expect(noChangeLines(EMPTY_THREAD).size).toBe(0);
  });

  it('dims the newest words while another draft is in the form: their readings are not its', () => {
    const id = noChangeIds();
    const first = startThread([lunch, standup], 'lunch and the standup', { id });
    const idle = refineThread(first, 'invite Tom', [{ id: 'n1', item: lunch }], id);
    expect(saidAt(noChangeLines(idle))).toEqual([[1, ['invite Tom']]]);
    expect(saidAt(noChangeLines(focusDraft(idle, 1)))).toEqual([[1, ['invite Tom (dimmed)']]]);
    // Words said to both drafts are no one draft's.
    const both = refineThread(
      idle,
      'both at one',
      [
        { id: 'n1', item: lunch },
        { id: 'n2', item: standup },
      ],
      id,
    );
    expect(saidAt(noChangeLines(focusDraft(both, 1))).at(-1)).toEqual([
      1,
      ['invite Tom (dimmed)', 'both at one'],
    ]);
  });

  it('puts words said to a saved item before any step at 0', () => {
    const id = noChangeIds();
    const opened = openThread({ item: lunch }, id);
    const idle = refineThread(opened, 'at one', [{ id: 'n1', item: lunch }], id);
    expect(saidAt(noChangeLines(idle))).toEqual([[0, ['at one']]]);
  });
});
