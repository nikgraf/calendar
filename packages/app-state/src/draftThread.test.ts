import { describe, expect, it } from 'vite-plus/test';
import { changedDraftFields, describeDraftItem, summarizeChange } from './draftChanges.ts';
import {
  dropInviteeChoice,
  dropPlaceChoice,
  dropSlots,
  EMPTY_THREAD,
  firstDraftExtras,
  focusDraft,
  foldForm,
  isAtSlot,
  itemAtSlot,
  keepShown,
  landPlacement,
  landRefinement,
  mergeRefinement,
  openThread,
  phraseSteps,
  refineTargets,
  refineThread,
  removeDraft,
  reseedRule,
  removeDrafts,
  slotItem,
  startThread,
  stepTo,
  threadLine,
  turnsOf,
  undoTurn,
  updateDraft,
} from './draftThread.ts';
import {
  Contact,
  EventReminders,
  GeoLocation,
  type PlaceCandidate,
  ReminderOverride,
} from '@calendar/core';
import { livePlaceChoice, pickedCandidate, placeAsSaid, readsAsSaid } from './draftPlaces.ts';
import type { QuickAddItem } from './quickAddItem.ts';

const dinner: QuickAddItem = {
  kind: 'event',
  prefill: {
    date: '2026-08-28',
    endTime: '20:00',
    isAllDay: false,
    startTime: '19:00',
    title: 'Dinner with Teo',
  },
};
const planning: QuickAddItem = {
  kind: 'event',
  prefill: {
    date: '2026-08-29',
    endTime: '15:00',
    isAllDay: false,
    startTime: '14:00',
    title: 'Planning',
  },
};
const later: QuickAddItem = {
  kind: 'event',
  prefill: { ...dinner.prefill, endTime: '21:00', startTime: '20:00' },
};

/** Dinner repeating by a rule given as written (its parts in any order). */
const rule = (recurrence: Record<string, unknown>): QuickAddItem =>
  ({ kind: 'event', prefill: { ...dinner.prefill, recurrence } }) as QuickAddItem;

/** Stable ids: d1, d2, … in the order they are asked for. */
const ids = () => {
  let count = 0;
  return () => {
    count += 1;
    return `d${String(count)}`;
  };
};

describe('startThread', () => {
  it('makes a draft per item, focuses the first and records the phrase', () => {
    const state = startThread([dinner, planning], 'Dinner with Teo Friday, planning Saturday', {
      id: ids(),
    });
    expect(state.drafts.map((draft) => draft.id)).toEqual(['d1', 'd2']);
    expect(state.focused).toBe(0);
    expect(state.steps).toEqual([
      {
        drafts: ['d1', 'd2'],
        id: 'd3',
        kind: 'phrase',
        summary: '2 drafts',
        utterance: 'Dinner with Teo Friday, planning Saturday',
      },
    ]);
    // Undo of the first turn leads to nothing.
    expect(state.history).toEqual([{ drafts: [], focused: 0 }]);
  });

  it('describes a single draft in its first turn', () => {
    const state = startThread([dinner], 'Dinner with Teo next Friday', { id: ids() });
    expect(phraseSteps(state)[0]?.summary).toBe('Dinner with Teo · Fri, Aug 28 · 19:00–20:00');
  });
});

describe('describeDraftItem', () => {
  it('says the day and the times, or the day alone', () => {
    expect(describeDraftItem(dinner)).toBe('Fri, Aug 28 · 19:00–20:00');
    expect(
      describeDraftItem({ kind: 'event', prefill: { ...dinner.prefill, isAllDay: true } }),
    ).toBe('Fri, Aug 28');
    expect(
      describeDraftItem({
        kind: 'task',
        prefill: { date: '2026-08-25', time: '09:30', title: 'Bank' },
      }),
    ).toBe('Tue, Aug 25 · 09:30');
  });

  it('names both days of a draft that ends on a later one', () => {
    expect(
      describeDraftItem({
        kind: 'event',
        prefill: { ...dinner.prefill, endDate: '2026-08-30', isAllDay: true },
      }),
    ).toBe('Fri, Aug 28 – Sun, Aug 30');
    expect(
      describeDraftItem({
        kind: 'event',
        prefill: { ...dinner.prefill, endDate: '2026-08-29', endTime: '01:00', startTime: '23:00' },
      }),
    ).toBe('Fri, Aug 28 · 23:00 – Sat, Aug 29 · 01:00');
  });
});

describe('summarizeChange', () => {
  it('names each field that changed', () => {
    expect(summarizeChange(dinner, later)).toBe('→ 20:00–21:00');
    expect(
      summarizeChange(dinner, {
        kind: 'event',
        prefill: { ...later.prefill, date: '2026-08-27', title: 'Team dinner' },
      }),
    ).toBe('→ “Team dinner” · → Thu, Aug 27 · → 20:00–21:00');
    expect(
      summarizeChange(dinner, { kind: 'event', prefill: { ...dinner.prefill, isAllDay: true } }),
    ).toBe('→ all day');
    expect(
      summarizeChange(dinner, {
        kind: 'event',
        prefill: { ...dinner.prefill, location: "Luigi's", recurrence: { freq: 'weekly' } },
      }),
    ).toBe("→ Luigi's · → repeats weekly");
    expect(summarizeChange(dinner, dinner)).toBe('no change');
    expect(
      summarizeChange(dinner, {
        kind: 'task',
        prefill: { date: '2026-08-28', title: 'Dinner with Teo' },
      }),
    ).toBe('→ a to-do · → no time');
    // A rule changed within its frequency still says so.
    expect(
      summarizeChange(
        { kind: 'event', prefill: { ...dinner.prefill, recurrence: { freq: 'weekly' } } },
        {
          kind: 'event',
          prefill: {
            ...dinner.prefill,
            recurrence: { byDay: [{ weekday: 'MO' }], freq: 'weekly' },
          },
        },
      ),
    ).toBe('→ repeats weekly');
  });
});

describe('changedDraftFields', () => {
  it('names the fields that differ, for the form to flash', () => {
    expect(changedDraftFields(dinner, dinner)).toEqual([]);
    expect(changedDraftFields(dinner, later)).toEqual(['time']);
    // A new last day is a date change.
    expect(
      changedDraftFields(dinner, {
        kind: 'event',
        prefill: { ...dinner.prefill, endDate: '2026-08-29' },
      }),
    ).toEqual(['date']);
    expect(
      changedDraftFields(dinner, {
        kind: 'event',
        prefill: { ...later.prefill, date: '2026-08-27', location: "Luigi's", title: 'Team' },
      }),
    ).toEqual(['title', 'date', 'time', 'location']);
    expect(
      changedDraftFields(dinner, { kind: 'event', prefill: { ...dinner.prefill, isAllDay: true } }),
    ).toEqual(['time']);
    expect(
      changedDraftFields(dinner, {
        kind: 'event',
        prefill: { ...dinner.prefill, recurrence: { freq: 'daily' } },
      }),
    ).toEqual(['repeat']);
    expect(
      changedDraftFields(dinner, {
        kind: 'task',
        prefill: { date: '2026-08-28', title: 'Dinner' },
      }),
    ).toEqual(['kind', 'title', 'time']);
  });

  it('reads a repeat rule by its values, not the order its parts were written in', () => {
    const form = rule({
      byDay: [{ weekday: 'MO' }, { weekday: 'TH' }],
      freq: 'weekly',
      interval: 2,
    });
    const restated = rule({
      freq: 'weekly',
      interval: 2,
      // eslint-disable-next-line perfectionist/sort-objects -- the model's order, on purpose
      byDay: [{ weekday: 'TH' }, { weekday: 'MO' }],
    });
    expect(changedDraftFields(form, restated)).toEqual([]);
    expect(summarizeChange(form, restated)).toBe('no change');
    // An interval of one is the default either way.
    expect(
      changedDraftFields(rule({ freq: 'daily' }), rule({ freq: 'daily', interval: 1 })),
    ).toEqual([]);
    expect(
      changedDraftFields(form, rule({ byDay: [{ weekday: 'MO' }], freq: 'weekly', interval: 2 })),
    ).toEqual(['repeat']);
  });
});

describe('refineTargets', () => {
  const state = startThread([dinner, planning], 'x', { id: ids() });

  it('addresses the focused draft unless the words say all', () => {
    expect(refineTargets(state, 'at 8').map((draft) => draft.id)).toEqual(['d1']);
    // Review: "all day" is a length, not an address.
    expect(refineTargets(state, 'make it all day').map((draft) => draft.id)).toEqual(['d1']);
    expect(refineTargets(state, 'all-day').map((draft) => draft.id)).toEqual(['d1']);
    expect(refineTargets(focusDraft(state, 1), 'at 8').map((draft) => draft.id)).toEqual(['d2']);
    expect(refineTargets(state, 'move both to 8').map((draft) => draft.id)).toEqual(['d1', 'd2']);
    expect(refineTargets(state, 'alle auf 8').map((draft) => draft.id)).toEqual(['d1', 'd2']);
    // "every" is a repeat word, not an address.
    expect(refineTargets(state, 'every week').map((draft) => draft.id)).toEqual(['d1']);
  });
});

describe('refineThread and undoTurn', () => {
  it('replaces the changed drafts, keeps the rest, and records what changed', () => {
    const id = ids();
    const started = startThread([dinner, planning], 'x', { id });
    const refined = refineThread(started, 'at 8', [{ id: 'd1', item: later }], id);
    expect(refined.drafts.map((draft) => draft.item)).toEqual([later, planning]);
    expect(refined.steps.at(-1)).toEqual({
      drafts: ['d1'],
      id: 'd4',
      kind: 'phrase',
      summary: '→ 20:00–21:00',
      utterance: 'at 8',
    });
    expect(refined.history).toHaveLength(2);

    const undone = undoTurn(refined);
    expect(undone.drafts.map((draft) => draft.item)).toEqual([dinner, planning]);
    expect(undone.steps).toHaveLength(1);
    // The first turn taken back: an empty thread.
    const empty = undoTurn(undone);
    expect(empty.drafts).toEqual([]);
    expect(empty.steps).toEqual([]);
    expect(undoTurn(empty)).toBe(empty);
    // Every step the form must take over moved the version.
    expect([started.version, refined.version, undone.version, empty.version]).toEqual([1, 2, 3, 4]);
  });

  it('counts the drafts a turn changed when more than one did', () => {
    const id = ids();
    const started = startThread([dinner, planning], 'x', { id });
    const refined = refineThread(
      started,
      'both at 8',
      [
        { id: 'd1', item: later },
        { id: 'd2', item: { kind: 'event', prefill: { ...planning.prefill, startTime: '20:00' } } },
      ],
      id,
    );
    expect(phraseSteps(refined).at(-1)?.summary).toBe('→ 20:00–21:00 (2 drafts)');
  });

  it('restores the focus the turn started with', () => {
    const id = ids();
    const focused = focusDraft(startThread([dinner, planning], 'x', { id }), 1);
    const refined = refineThread(focused, 'at 8', [{ id: 'd2', item: later }], id);
    expect(undoTurn(focusDraft(refined, 0)).focused).toBe(1);
  });
});

describe('turnsOf', () => {
  it('gives a draft the words that made or changed it, and no other draft’s', () => {
    // Review: "in Vienna" said to one draft took the city off another's place.
    const id = ids();
    const started = startThread([dinner, planning], 'two things', { id });
    const first = refineThread(started, 'at 8', [{ id: 'd1', item: later }], id);
    const second = refineThread(
      first,
      'in Vienna',
      [{ id: 'd2', item: { kind: 'event', prefill: { ...planning.prefill, location: 'Vienna' } } }],
      id,
    );
    expect(turnsOf(second, 'd1')).toEqual(['two things', 'at 8']);
    expect(turnsOf(second, 'd2')).toEqual(['two things', 'in Vienna']);
    // A turn that changed nothing is nobody's: its words added nothing to lean on.
    const idle = refineThread(
      second,
      'in Vienna',
      [{ id: 'd2', item: second.drafts[1]!.item }],
      id,
    );
    expect(idle.steps.at(-1)?.drafts).toEqual([]);
    expect(turnsOf(idle, 'd2')).toEqual(['two things', 'in Vienna']);
    // Undo takes the words back.
    expect(turnsOf(undoTurn(undoTurn(idle)), 'd2')).toEqual(['two things']);
    expect(turnsOf(idle, 'gone')).toEqual([]);
  });
});

describe('focus, update and remove', () => {
  const state = startThread([dinner, planning], 'x', { id: ids() });

  it('focuses within bounds only', () => {
    expect(focusDraft(state, 1).focused).toBe(1);
    expect(focusDraft(state, 2)).toBe(state);
    expect(focusDraft(state, -1)).toBe(state);
  });

  it('keeps the form edits on the draft without a turn, and without moving the version', () => {
    const edited = updateDraft(state, 0, later);
    expect(edited.drafts[0]?.item).toEqual(later);
    expect(edited.steps).toEqual(state.steps);
    expect(edited.version).toBe(state.version);
    expect(updateDraft(state, 5, later)).toBe(state);
    expect(focusDraft(state, 1).version).toBe(state.version + 1);
    // Review: another draft going must not re-apply the focused one to the form.
    expect(removeDraft(state, 1).version).toBe(state.version);
    expect(removeDraft(state, 0).version).toBe(state.version + 1);
    expect(removeDrafts(state, ['d1', 'd2']).version).toBe(state.version + 1);
  });

  it('drops several drafts by id, the focus following its draft', () => {
    const three = startThread([dinner, planning, later], 'x', { id: ids() });
    const second = focusDraft(three, 1);
    const kept = removeDrafts(second, ['d1', 'd3']);
    expect(kept.drafts.map((draft) => draft.id)).toEqual(['d2']);
    expect(kept.focused).toBe(0);
    const focusedGone = removeDrafts(second, ['d2']);
    expect(focusedGone.drafts.map((draft) => draft.id)).toEqual(['d1', 'd3']);
    expect(focusedGone.focused).toBe(1);
    expect(removeDrafts(three, ['nope'])).toBe(three);
  });

  it('drops a draft and keeps the focus on the same draft where it can', () => {
    const second = focusDraft(state, 1);
    const withoutFirst = removeDraft(second, 0);
    expect(withoutFirst.drafts.map((draft) => draft.id)).toEqual(['d2']);
    expect(withoutFirst.focused).toBe(0);
    const withoutLast = removeDraft(second, 1);
    expect(withoutLast.focused).toBe(0);
    expect(removeDraft(EMPTY_THREAD, 0)).toBe(EMPTY_THREAD);
  });

  it('keeps a written draft out of the history, so Undo cannot bring it back', () => {
    // Review: after a turn, saving one draft and undoing the turn restored it.
    const id = ids();
    const started = startThread([dinner, planning], 'x', { id });
    const refined = refineThread(started, 'at 8', [{ id: 'd1', item: later }], id);
    const saved = removeDraft(refined, 0);
    expect(saved.drafts.map((draft) => draft.id)).toEqual(['d2']);
    const undone = undoTurn(saved);
    expect(undone.drafts.map((draft) => draft.id)).toEqual(['d2']);
    expect(undone.steps).toHaveLength(1);
  });

  it('makes a step of what the form changed by hand, and none of what it did not', () => {
    const id = ids();
    const started = startThread([dinner, planning], 'x', { id });
    // Read back as it is: nothing to go back over.
    const same = foldForm(started, { item: dinner }, { kind: 'edit' }, id);
    expect(same.steps).toEqual(started.steps);
    expect(same.history).toEqual(started.history);

    const moved = foldForm(started, { item: later }, { kind: 'edit' }, id);
    expect(moved.drafts[0]?.item).toEqual(later);
    expect(moved.steps.at(-1)).toEqual({
      drafts: ['d1'],
      fields: ['time'],
      id: 'd4',
      kind: 'edit',
    });
    expect(moved.history.at(-1)?.drafts[0]?.item).toEqual(dinner);
    // The form already shows it: nothing for it to take over.
    expect(moved.version).toBe(started.version);
    // No draft to fold into: the thread stays.
    expect(foldForm(EMPTY_THREAD, { item: later })).toBe(EMPTY_THREAD);
  });

  it('joins further edits of the same field to the step, and starts another for another field', () => {
    const id = ids();
    const typed = (title: string): QuickAddItem => ({
      kind: 'event',
      prefill: { ...dinner.prefill, title },
    });
    const started = startThread([dinner], 'x', { id });
    const one = foldForm(started, { item: typed('Dinner with T') }, { kind: 'edit' }, id);
    const two = foldForm(one, { item: typed('Dinner with Tom') }, { kind: 'edit' }, id);
    // A title typed letter by letter is one step, from where it began.
    expect(two.steps).toHaveLength(2);
    expect(two.history.at(-1)?.drafts[0]?.item).toEqual(dinner);
    expect(two.drafts[0]?.item.prefill.title).toBe('Dinner with Tom');

    const timed = foldForm(
      two,
      { item: { kind: 'event', prefill: { ...later.prefill, title: 'Dinner with Tom' } } },
      { kind: 'edit' },
      id,
    );
    expect(timed.steps.map((step) => (step.kind === 'edit' ? step.fields : step.kind))).toEqual([
      'phrase',
      ['title'],
      ['time'],
    ]);
  });

  it('drops a step whose edits end where they began', () => {
    const id = ids();
    const started = startThread([dinner], 'x', { id });
    const away = foldForm(started, { item: later }, { kind: 'edit' }, id);
    const back = foldForm(away, { item: dinner }, { kind: 'edit' }, id);
    expect(back.steps).toEqual(started.steps);
    expect(back.history).toEqual(started.history);
    expect(back.drafts[0]?.item).toEqual(dinner);
  });

  it('keeps a pick as its own step, and settles the choice it answered with it', () => {
    const id = ids();
    const asked = startThread([dinner], 'dinner, invite Mia', {
      guests: {
        add: [],
        choices: [{ contacts: [], name: 'Mia' }],
        invited: ['Mia'],
        remove: [],
      },
      id,
    });
    const mia = { displayName: 'Mia Ko', email: 'mia@example.com' };
    const extras = { attendees: [mia], description: '', reminders: undefined };
    const picked = foldForm(
      asked,
      { extras, item: dinner },
      { kind: 'pick', name: 'Mia', pick: 'guest' },
      id,
    );
    expect(picked.steps.at(-1)).toEqual({ drafts: ['d1'], id: 'd3', kind: 'pick', pick: 'guest' });
    expect(picked.drafts[0]).not.toHaveProperty('inviteeChoices');
    // Before the pick the name was still open: going back asks again.
    expect(picked.history.at(-1)?.drafts[0]?.inviteeChoices).toEqual([
      { contacts: [], name: 'Mia' },
    ]);
    // An edit right after it is not the pick's: guests again, but another step.
    const more = foldForm(
      picked,
      { extras: { ...extras, attendees: [] }, item: dinner },
      { kind: 'edit' },
      id,
    );
    expect(more.steps).toHaveLength(3);
    // A pick that put nothing new in the form still answers its question.
    const again = foldForm(
      asked,
      { item: dinner },
      { kind: 'pick', name: 'Mia', pick: 'guest' },
      id,
    );
    expect(again.steps).toEqual(asked.steps);
    expect(again.drafts[0]).not.toHaveProperty('inviteeChoices');
  });

  it('takes a turn back with what was done by hand since it landed', () => {
    const id = ids();
    const started = startThread([dinner], 'x', { id });
    const refined = refineThread(started, 'at 8', [{ id: 'd1', item: later }], id);
    const retitled = foldForm(
      refined,
      { item: { kind: 'event', prefill: { ...later.prefill, title: 'Late dinner' } } },
      { kind: 'edit' },
      id,
    );
    expect(retitled.steps.map((step) => step.kind)).toEqual(['phrase', 'phrase', 'edit']);
    const undone = undoTurn(retitled);
    expect(undone.drafts[0]?.item).toEqual(dinner);
    expect(undone.steps).toEqual(started.steps);
    expect(undone.history).toEqual(started.history);
  });

  it('lets the steps made by hand on a written draft go with it', () => {
    const id = ids();
    const started = startThread([dinner, planning], 'x', { id });
    const edited = foldForm(started, { item: later }, { kind: 'edit' }, id);
    expect(edited.steps).toHaveLength(2);
    const saved = removeDraft(edited, 0);
    expect(saved.steps).toEqual(started.steps);
    expect(saved.history).toEqual([{ drafts: [], focused: 0 }]);
    // The other draft's step stays when it is the other one that is written.
    expect(removeDraft(edited, 1).steps).toHaveLength(2);
  });

  it('shows an older step without letting the later ones go, and goes forward to them again', () => {
    const id = ids();
    const started = startThread([dinner], 'x', { id });
    const refined = refineThread(started, 'at 8', [{ id: 'd1', item: later }], id);
    const retitled = foldForm(
      refined,
      { item: { kind: 'event', prefill: { ...later.prefill, title: 'Late dinner' } } },
      { kind: 'edit' },
      id,
    );
    expect(
      threadLine(retitled).map((line) => [line.position, line.step.kind, line.dimmed]),
    ).toEqual([
      [1, 'phrase', false],
      [2, 'phrase', false],
      [3, 'edit', false],
    ]);

    const first = stepTo(retitled, 1);
    expect(first.drafts[0]?.item).toEqual(dinner);
    expect(first.steps).toHaveLength(1);
    expect(first.ahead.map((gone) => gone.step.kind)).toEqual(['phrase', 'edit']);
    // The form must take the drafts over.
    expect(first.version).toBe(retitled.version + 1);
    // Every step is still listed, the ones stepped back over dimmed, each between its own drafts.
    const line = threadLine(first);
    expect(line.map((each) => each.dimmed)).toEqual([false, true, true]);
    expect(line[1]?.before.drafts[0]?.item).toEqual(dinner);
    expect(line[1]?.after.drafts[0]?.item).toEqual(later);
    expect(line[2]?.after.drafts[0]?.item.prefill.title).toBe('Late dinner');

    // Forward again, one step and then to the newest: nothing was lost.
    const second = stepTo(first, 2);
    expect(second.drafts[0]?.item).toEqual(later);
    expect(second.ahead).toHaveLength(1);
    const newest = stepTo(second, 3);
    expect(newest.drafts).toEqual(retitled.drafts);
    expect(newest.steps).toEqual(retitled.steps);
    expect(newest.history).toEqual(retitled.history);
    expect(newest.ahead).toEqual([]);
  });

  it('shows the start before the first step, and nothing beyond the steps there are', () => {
    const id = ids();
    const started = startThread([dinner], 'x', { id });
    const refined = refineThread(started, 'at 8', [{ id: 'd1', item: later }], id);
    const start = stepTo(refined, 0);
    expect(start.drafts).toEqual([]);
    expect(start.steps).toEqual([]);
    expect(start.ahead).toHaveLength(2);
    expect(stepTo(start, 2).drafts).toEqual(refined.drafts);
    // The step on show, or none there is: the thread stays as it is.
    expect(stepTo(refined, 2)).toBe(refined);
    expect(stepTo(refined, 3)).toBe(refined);
    expect(stepTo(refined, -1)).toBe(refined);
  });

  it('keeps the step on show and lets the later ones go', () => {
    const id = ids();
    const started = startThread([dinner], 'x', { id });
    const refined = refineThread(started, 'at 8', [{ id: 'd1', item: later }], id);
    const kept = keepShown(stepTo(refined, 1));
    expect(kept.drafts[0]?.item).toEqual(dinner);
    expect(kept.steps).toEqual(started.steps);
    expect(kept.ahead).toEqual([]);
    expect(threadLine(kept)).toHaveLength(1);
    // Kept, the form already shows it: nothing to take over.
    expect(kept.version).toBe(stepTo(refined, 1).version);
    // Nothing on show to keep: the same thread.
    expect(keepShown(refined)).toBe(refined);
  });

  it('reads nothing by hand into an older step on show, and a turn from one leaves the later ones behind', () => {
    const id = ids();
    const started = startThread([dinner], 'x', { id });
    const refined = refineThread(started, 'at 8', [{ id: 'd1', item: later }], id);
    const first = stepTo(refined, 1);
    expect(foldForm(first, { item: planning })).toBe(first);
    const again = refineThread(first, 'at 9', [{ id: 'd1', item: planning }], id);
    expect(again.ahead).toEqual([]);
    expect(again.steps).toHaveLength(2);
  });

  it('keeps a written draft out of the steps stepped back over too', () => {
    const id = ids();
    const started = startThread([dinner, planning], 'x', { id });
    const refined = refineThread(started, 'at 8', [{ id: 'd1', item: later }], id);
    const edited = foldForm(refined, { item: dinner }, { kind: 'edit' }, id);
    const back = stepTo(edited, 1);
    const saved = removeDrafts(back, ['d1']);
    // The edit by hand on the written draft is gone; the phrase stays, without that draft.
    expect(saved.ahead.map((gone) => gone.step.kind)).toEqual(['phrase']);
    expect(saved.ahead[0]?.after.drafts.map((draft) => draft.id)).toEqual(['d2']);
  });

  it('opens a saved item as the first state of its thread: no step, and never nothing to go back to', () => {
    const id = ids();
    const extras = {
      attendees: [],
      calendarKey: 'acc:cal',
      description: 'Bring wine',
      reminders: undefined,
    };
    const opened = openThread({ extras, item: dinner }, id);
    expect(opened.drafts).toEqual([{ extras, id: 'd1', item: dinner }]);
    expect(opened.steps).toEqual([]);
    expect(opened.history).toEqual([]);
    // Nothing for the form to take over: it is what the form holds.
    expect(opened.version).toBe(0);

    // A phrase changes it; an edit by hand is a step from the start.
    const refined = refineThread(opened, 'at 8', [{ id: 'd1', item: later }], id);
    expect(refined.drafts[0]?.item).toEqual(later);
    expect(refined.drafts[0]?.extras).toEqual(extras);
    const edited = foldForm(opened, { extras, item: later }, { kind: 'edit' }, id);
    expect(edited.steps.map((step) => step.kind)).toEqual(['edit']);

    // Before the first step is the item as saved.
    const start = stepTo(refined, 0);
    expect(start.drafts).toEqual(opened.drafts);
    expect(undoTurn(refined).drafts).toEqual(opened.drafts);
  });

  it('starts a phrase draft with what the form already held', () => {
    const extras = {
      attendees: [{ email: 'anna@example.com' }],
      description: '',
      reminders: undefined,
    };
    expect(startThread([dinner], 'x', { extras, id: ids() }).drafts[0]?.extras).toEqual(extras);
    expect(startThread([dinner], 'x', { id: ids() }).drafts[0]).not.toHaveProperty('extras');
  });

  it('merges a turn onto the form as it is now', () => {
    // Review: an edit made while the model answered was overwritten by the turn.
    const before = dinner;
    const fresh = {
      kind: 'event' as const,
      prefill: { ...dinner.prefill, title: 'Dinner with Teo & Anna' },
    };
    const after = later;
    expect(mergeRefinement(fresh, before, after)).toEqual({
      kind: 'event',
      prefill: {
        ...dinner.prefill,
        endTime: '21:00',
        startTime: '20:00',
        title: 'Dinner with Teo & Anna',
      },
    });
    // A field the turn cleared is cleared.
    const placed = { kind: 'event' as const, prefill: { ...dinner.prefill, location: "Luigi's" } };
    expect(mergeRefinement(placed, placed, dinner).prefill).not.toHaveProperty('location');
    // A kind change takes the turn whole.
    const todo = { kind: 'task' as const, prefill: { date: '2026-08-28', title: 'Dinner' } };
    expect(mergeRefinement(fresh, before, todo)).toBe(todo);
  });

  it('keeps what the form holds beyond the fields with the draft', () => {
    const extras = {
      attendees: [{ email: 'anna@example.com' }],
      description: 'bring slides',
      reminders: undefined,
    };
    const edited = updateDraft(state, 0, later, extras);
    expect(edited.drafts[0]?.extras).toEqual(extras);
    // A later edit without extras keeps them.
    expect(updateDraft(edited, 0, dinner).drafts[0]?.extras).toEqual(extras);
  });
});

describe('slots on a draft', () => {
  const slots = [
    { date: '2026-08-28', endTime: '10:30', startTime: '10:00' },
    { date: '2026-08-28', endTime: '11:30', startTime: '11:00' },
    { date: '2026-08-29', endTime: '09:30', startTime: '09:00' },
  ];

  it('a finder phrase starts the thread with the draft in the best slot and the rest beside it', () => {
    const state = startThread([slotItem(slots[0]!, 'Focus')], 'find 30 min tomorrow morning', {
      id: ids(),
      slots,
    });
    expect(state.drafts[0]?.slots).toEqual(slots);
    expect(state.drafts[0]?.item).toEqual({
      kind: 'event',
      prefill: {
        date: '2026-08-28',
        endTime: '10:30',
        isAllDay: false,
        startTime: '10:00',
        title: 'Focus',
      },
    });
    expect(phraseSteps(state)[0]?.summary).toBe('Focus · Fri, Aug 28 · 10:00–10:30 · 3 free slots');
  });

  it('a finder turn moves the focused draft into the best slot, title kept, slots along; the next turn drops them, Undo brings them back', () => {
    const id = ids();
    const started = startThread([dinner], 'x', { id });
    const placed = refineThread(
      started,
      'find a slot tomorrow morning',
      [{ id: 'd1', item: itemAtSlot(dinner, slots[0]!, 'Focus'), slots }],
      id,
    );
    expect(placed.drafts[0]?.item.prefill).toMatchObject({
      date: '2026-08-28',
      endTime: '10:30',
      startTime: '10:00',
      title: 'Dinner with Teo',
    });
    expect(placed.drafts[0]?.slots).toEqual(slots);
    expect(phraseSteps(placed).at(-1)?.summary).toBe('→ 10:00–10:30 · 3 free slots');

    const moved = refineThread(placed, 'at 8', [{ id: 'd1', item: later }], id);
    expect(moved.drafts[0]).not.toHaveProperty('slots');
    expect(undoTurn(moved).drafts[0]?.slots).toEqual(slots);
  });

  it('lets go of every slot once they no longer hold, on the steps to go back and forward to as well', () => {
    const id = ids();
    const started = startThread([dinner], 'x', { id });
    const placed = refineThread(
      started,
      'find a slot tomorrow morning',
      [{ id: 'd1', item: itemAtSlot(dinner, slots[0]!, 'Focus'), slots }],
      id,
    );
    const moved = refineThread(placed, 'at 8', [{ id: 'd1', item: later }], id);
    // The finder's step is behind the newest one, and ahead of the first once stepped back.
    const dropped = dropSlots(moved);
    expect(undoTurn(dropped).drafts[0]).not.toHaveProperty('slots');
    const back = dropSlots(stepTo(moved, 1));
    expect(stepTo(back, 2).drafts[0]).not.toHaveProperty('slots');
    // The drafts themselves, where they are, and nothing else about them.
    const bare = dropSlots(placed);
    expect(bare.drafts[0]).not.toHaveProperty('slots');
    expect(bare.drafts[0]?.item).toEqual(placed.drafts[0]?.item);
    expect(bare.steps).toBe(placed.steps);
    // Nothing offered anywhere: the same thread.
    expect(dropSlots(started)).toBe(started);
  });

  it('a form edit keeps the slots', () => {
    const state = startThread([dinner], 'x', { id: ids(), slots });
    expect(updateDraft(state, 0, later).drafts[0]?.slots).toEqual(slots);
  });

  it('a single slot is no row: the summary stays plain', () => {
    const state = startThread([dinner], 'x', { id: ids(), slots: slots.slice(0, 1) });
    expect(phraseSteps(state)[0]?.summary).toBe('Dinner with Teo · Fri, Aug 28 · 19:00–20:00');
  });
});

describe('itemAtSlot, slotItem and isAtSlot', () => {
  const slot = { date: '2026-09-01', endTime: '10:30', startTime: '10:00' };

  it('moves an event into the slot, timed, the assumed-time mark gone, a blank title taken from the phrase', () => {
    expect(
      itemAtSlot(
        {
          kind: 'event',
          prefill: {
            assumedTime: true,
            date: '2026-08-28',
            endTime: '20:00',
            isAllDay: false,
            startTime: '19:00',
            title: '',
          },
        },
        slot,
        'Focus',
      ),
    ).toEqual({
      kind: 'event',
      prefill: {
        date: '2026-09-01',
        endTime: '10:30',
        isAllDay: false,
        startTime: '10:00',
        title: 'Focus',
      },
    });
    expect(itemAtSlot(dinner, slot, 'Focus').prefill.title).toBe('Dinner with Teo');
  });

  it('ends a draft that spanned days on the slot’s day', () => {
    const spanning: QuickAddItem = {
      kind: 'event',
      prefill: { ...dinner.prefill, endDate: '2026-08-29' },
    };
    const moved = itemAtSlot(spanning, slot);
    if (moved.kind !== 'event') {
      throw new Error('expected an event');
    }
    expect(moved.prefill.endDate).toBeUndefined();
    expect(isAtSlot(moved, slot)).toBe(true);
    const overnight: QuickAddItem = {
      kind: 'event',
      prefill: { ...moved.prefill, endDate: '2026-09-02' },
    };
    expect(isAtSlot(overnight, slot)).toBe(false);
  });

  it('makes a to-do due at the slot’s start', () => {
    expect(
      itemAtSlot({ kind: 'task', prefill: { date: '2026-08-28', title: 'Call the bank' } }, slot),
    ).toEqual({
      kind: 'task',
      prefill: { date: '2026-09-01', time: '10:00', title: 'Call the bank' },
    });
  });

  it('a new draft in a slot is a timed event, untitled without a phrase title', () => {
    expect(slotItem(slot)).toEqual({
      kind: 'event',
      prefill: {
        date: '2026-09-01',
        endTime: '10:30',
        isAllDay: false,
        startTime: '10:00',
        title: '',
      },
    });
  });

  it('tells the slot the item sits in', () => {
    expect(isAtSlot(slotItem(slot), slot)).toBe(true);
    expect(isAtSlot(dinner, slot)).toBe(false);
    expect(
      isAtSlot(
        {
          kind: 'event',
          prefill: {
            date: '2026-09-01',
            endTime: '10:30',
            isAllDay: true,
            startTime: '10:00',
            title: '',
          },
        },
        slot,
      ),
    ).toBe(false);
  });
});

describe('landRefinement — the answer lands on the draft it was asked about', () => {
  const edited: QuickAddItem = {
    kind: 'event',
    prefill: { ...dinner.prefill, title: 'Dinner with Teo and Ana' },
  };
  const planningEdited: QuickAddItem = {
    kind: 'event',
    prefill: { ...planning.prefill, title: 'Planning (edited)' },
  };
  const change = { id: 'd1', item: later };

  it('while the draft is still focused, the change lands on the form as it is now', () => {
    const state = startThread([dinner, planning], 'x', { id: ids() });
    const landed = landRefinement(state, {
      changes: [change],
      fresh: { item: edited },
      submitted: { item: dinner },
      targetId: 'd1',
      utterance: 'at 8',
    });
    // The title typed meanwhile stays; the times are the turn's.
    expect(landed.drafts[0]?.item.prefill).toMatchObject({
      endTime: '21:00',
      startTime: '20:00',
      title: 'Dinner with Teo and Ana',
    });
    expect(landed.drafts[1]?.item).toEqual(planning);
  });

  it('after a switch, the form is another draft’s: the target lands on its stored copy, the form’s edits stay with the draft it shows', () => {
    const id = ids();
    // The user left d1 with an edit (switchFocus stores it) and opened d2.
    const state = focusDraft(
      updateDraft(startThread([dinner, planning], 'x', { id }), 0, edited),
      1,
    );
    const landed = landRefinement(state, {
      changes: [change],
      // The form now shows d2, edited.
      fresh: { item: planningEdited },
      submitted: { item: dinner },
      targetId: 'd1',
      utterance: 'at 8',
    });
    expect(landed.drafts[0]?.item.prefill).toMatchObject({
      endTime: '21:00',
      startTime: '20:00',
      title: 'Dinner with Teo and Ana',
    });
    // d2 keeps what the form typed into it meanwhile: the turn's re-apply must not wipe it.
    expect(landed.drafts[1]?.item).toEqual(planningEdited);
    expect(landed.history.at(-1)?.drafts[1]?.item).toEqual(planningEdited);
    expect(landed.focused).toBe(1);
  });

  it('without a form, the change is folded in as it is', () => {
    const state = startThread([dinner], 'x', { id: ids() });
    expect(
      landRefinement(state, { changes: [change], targetId: 'd1', utterance: 'at 8' }).drafts[0]
        ?.item,
    ).toEqual(later);
  });
});

describe('landPlacement — the finder turn lands on the draft it was asked for', () => {
  const slots = [
    { date: '2026-08-29', endTime: '10:30', startTime: '10:00' },
    { date: '2026-08-29', endTime: '11:30', startTime: '11:00' },
  ];

  it('moves the focused draft from the form as it is now, slots along', () => {
    const state = startThread([dinner], 'x', { id: ids() });
    const landed = landPlacement(state, {
      fresh: { item: { kind: 'event', prefill: { ...dinner.prefill, title: 'Dinner (edited)' } } },
      slots,
      targetId: 'd1',
      title: 'Focus',
      utterance: 'find a slot tomorrow morning',
    });
    expect(landed.drafts[0]?.item.prefill).toMatchObject({
      date: '2026-08-29',
      endTime: '10:30',
      startTime: '10:00',
      title: 'Dinner (edited)',
    });
    expect(landed.drafts[0]?.slots).toEqual(slots);
  });

  it('after a switch, moves the target from its stored copy and keeps the form’s edits on the draft it shows', () => {
    const id = ids();
    const state = focusDraft(startThread([dinner, planning], 'x', { id }), 1);
    const planningEdited: QuickAddItem = {
      kind: 'event',
      prefill: { ...planning.prefill, title: 'Planning (edited)' },
    };
    const landed = landPlacement(state, {
      fresh: { item: planningEdited },
      slots,
      targetId: 'd1',
      utterance: 'find a slot tomorrow morning',
    });
    expect(landed.drafts[0]?.item.prefill).toMatchObject({
      date: '2026-08-29',
      startTime: '10:00',
      title: 'Dinner with Teo',
    });
    expect(landed.drafts[1]?.item).toEqual(planningEdited);
    expect(landed.drafts[1]).not.toHaveProperty('slots');
  });

  it('dates a to-do the form had let go of', () => {
    const todo: QuickAddItem = {
      kind: 'task',
      prefill: { date: '2026-08-28', title: 'Call the bank' },
    };
    const extras = { attendees: [], description: '', reminders: undefined, undated: true };
    const state = startThread([todo], 'x', { extras, id: ids() });
    const landed = landPlacement(state, {
      fresh: { extras, item: todo },
      slots,
      targetId: 'd1',
      utterance: 'find a slot tomorrow morning',
    });
    expect(landed.drafts[0]?.item).toEqual({
      kind: 'task',
      prefill: { date: '2026-08-29', time: '10:00', title: 'Call the bank' },
    });
    expect(landed.drafts[0]?.extras?.undated).toBe(false);
    // Undo: undated again.
    expect(undoTurn(landed).drafts[0]?.extras?.undated).toBe(true);
  });

  it('is a no-op for a draft that left the thread, or no slot', () => {
    const state = startThread([dinner], 'x', { id: ids() });
    expect(landPlacement(state, { slots, targetId: 'gone', utterance: 'x' })).toBe(state);
    expect(landPlacement(state, { slots: [], targetId: 'd1', utterance: 'x' })).toBe(state);
  });
});

describe('firstDraftExtras', () => {
  it('keeps what the form held but an undated to-do’s state: the phrase dates the draft', () => {
    const extras = {
      attendees: [],
      description: 'notes',
      reminders: undefined,
      taskNotes: 'bring the card',
      undated: true,
    };
    expect(firstDraftExtras(extras)).toEqual({
      attendees: [],
      description: 'notes',
      reminders: undefined,
      taskNotes: 'bring the card',
    });
    expect(firstDraftExtras(undefined)).toBeUndefined();
  });
});

describe('guests from the words', () => {
  const tom = { displayName: 'Tom Baker', email: 'tom@example.com' };
  const anna = { displayName: 'Anna Lee', email: 'anna@example.com' };
  const mia = new Contact({
    displayName: 'Mia Ko',
    email: 'mia@example.com',
    id: 'g:mia',
    source: 'google',
  });
  const miaToo = new Contact({
    displayName: 'Mia Lu',
    email: 'lu@example.com',
    id: 'g:lu',
    source: 'device',
  });
  const typed = { attendees: [anna], description: 'Bring wine', reminders: undefined };

  it('starts a draft with the guests the phrase invited, beside the ones typed before', () => {
    const state = startThread([dinner], 'dinner Friday at 7, invite Tom and Mia', {
      extras: typed,
      guests: {
        add: [tom],
        choices: [{ contacts: [mia, miaToo], name: 'Mia' }],
        invited: ['Tom', 'Mia'],
        remove: [],
      },
      id: ids(),
    });
    expect(state.drafts[0]).toMatchObject({
      extras: { attendees: [anna, tom], description: 'Bring wine' },
      inviteeChoices: [{ contacts: [mia, miaToo], name: 'Mia' }],
    });
    expect(phraseSteps(state)[0]?.summary).toBe(
      'Dinner with Teo · Fri, Aug 28 · 19:00–20:00 · invites Tom Baker · which Mia?',
    );
    // A draft the form never held gets blank extras around its guests.
    const fresh = startThread([dinner], 'invite Bo', {
      guests: {
        add: [{ email: 'bo@example.com' }],
        choices: [],
        invited: ['bo@example.com'],
        remove: [],
      },
      id: ids(),
    });
    expect(fresh.drafts[0]?.extras).toEqual({
      attendees: [{ email: 'bo@example.com' }],
      description: '',
      reminders: undefined,
    });
  });

  it('gives a to-do no guests', () => {
    const todo: QuickAddItem = { kind: 'task', prefill: { date: '2026-08-28', title: 'Call Tom' } };
    const state = startThread([todo], 'call Tom', {
      guests: { add: [tom], choices: [], invited: ['Tom'], remove: [] },
      id: ids(),
    });
    expect(state.drafts[0]).not.toHaveProperty('extras');
    expect(phraseSteps(state)[0]?.summary).toBe('Call Tom · Fri, Aug 28');
  });

  it('lands a turn’s guests on the form as it is now, says so, and Undo takes them back', () => {
    const started = startThread([dinner], 'dinner', { extras: typed, id: ids() });
    // A guest typed while the model answered stays.
    const form = { extras: { ...typed, attendees: [anna, tom] }, item: dinner };
    const landed = landRefinement(started, {
      changes: [
        {
          guests: {
            add: [{ displayName: 'Mia Ko', email: 'mia@example.com' }],
            choices: [{ contacts: [], name: 'Sarah' }],
            invited: ['Mia', 'Sarah'],
            remove: ['Anna'],
          },
          id: 'd1',
          item: dinner,
        },
      ],
      fresh: form,
      submitted: { extras: typed, item: dinner },
      targetId: 'd1',
      utterance: 'invite Mia and Sarah, remove Anna',
    });
    expect(landed.drafts[0]?.extras?.attendees).toEqual([
      tom,
      { displayName: 'Mia Ko', email: 'mia@example.com' },
    ]);
    expect(landed.drafts[0]?.inviteeChoices).toEqual([{ contacts: [], name: 'Sarah' }]);
    // Only guests changed: no "no change".
    expect(phraseSteps(landed).at(-1)?.summary).toBe(
      '→ invites Mia Ko · → uninvites Anna Lee · → no contact “Sarah”',
    );
    expect(landed.version).toBe(started.version + 1);
    // Undo: the form as the turn found it, the guest typed meanwhile kept.
    const undone = undoTurn(landed);
    expect(undone.drafts[0]?.extras?.attendees).toEqual([anna, tom]);
    expect(undone.drafts[0]).not.toHaveProperty('inviteeChoices');
  });

  it('keeps open choices through a turn about something else', () => {
    const started = startThread([dinner], 'dinner, invite Mia', {
      guests: {
        add: [],
        choices: [{ contacts: [mia, miaToo], name: 'Mia' }],
        invited: ['Mia'],
        remove: [],
      },
      id: ids(),
    });
    const moved = refineThread(started, 'at 8', [{ id: 'd1', item: later }], ids());
    expect(moved.drafts[0]?.inviteeChoices).toEqual([{ contacts: [mia, miaToo], name: 'Mia' }]);
    expect(phraseSteps(moved).at(-1)?.summary).toBe('→ 20:00–21:00');
  });

  it('settles an open choice when a later turn finds the name (contacts synced meanwhile)', () => {
    // Review: a retry that found Sarah left "No contact named Sarah" behind.
    const started = startThread([dinner], 'dinner, invite Sarah', {
      guests: {
        add: [],
        choices: [{ contacts: [], name: 'Sarah' }],
        invited: ['Sarah'],
        remove: [],
      },
      id: ids(),
    });
    const sarah = { displayName: 'Sarah Kim', email: 'sarah@example.com' };
    const found = refineThread(
      started,
      'invite sarah',
      [
        {
          guests: { add: [sarah], choices: [], invited: ['sarah'], remove: [] },
          id: 'd1',
          item: dinner,
        },
      ],
      ids(),
    );
    expect(found.drafts[0]?.extras?.attendees).toEqual([sarah]);
    expect(found.drafts[0]).not.toHaveProperty('inviteeChoices');
  });

  it('knows the place as the words said it, for a turn that says more of it', () => {
    const choice = {
      candidates: [figl('Figlmüller, Wollzeile 5, 1010 Vienna, Austria')],
      text: 'Figlmüller',
    };
    const [taken] = choice.candidates;
    // A place taken for the words: the words, not its address.
    expect(placeAsSaid(choice, taken!.geo.source, taken!.geo)).toBe('Figlmüller');
    // The text as said needs no other.
    expect(placeAsSaid(choice, 'Figlmüller', undefined)).toBeUndefined();
    expect(placeAsSaid(undefined, 'Figlmüller', undefined)).toBeUndefined();
    expect(placeAsSaid(choice, undefined, undefined)).toBeUndefined();
    // A place picked by hand, its choice gone: the name it is written with.
    const picked = new GeoLocation({
      lat: 48.2,
      lng: 16.35,
      name: 'Kaffemik',
      source: 'Kaffemik, Zollergasse 5, 1070 Vienna, Austria',
    });
    expect(placeAsSaid(undefined, picked.source, picked)).toBe('Kaffemik');
    // A pin whose text is not written with its name, or is no longer the form's: the text.
    const renamed = new GeoLocation({ ...picked, source: 'Praxis Dr. Huber' });
    expect(placeAsSaid(undefined, renamed.source, renamed)).toBeUndefined();
    expect(placeAsSaid(undefined, 'Zollergasse 5', picked)).toBeUndefined();
    // A choice the form moved away from says nothing of the new text.
    expect(placeAsSaid(choice, 'Plachutta', undefined)).toBeUndefined();
  });

  it('drops a choice settled by hand, without a turn or a version', () => {
    const started = startThread([dinner], 'dinner, invite Mia and Sarah', {
      guests: {
        add: [],
        choices: [
          { contacts: [mia, miaToo], name: 'Mia' },
          { contacts: [], name: 'Sarah' },
        ],
        invited: ['Mia', 'Sarah'],
        remove: [],
      },
      id: ids(),
    });
    const settled = dropInviteeChoice(started, 0, 'Mia');
    expect(settled.drafts[0]?.inviteeChoices).toEqual([{ contacts: [], name: 'Sarah' }]);
    expect(settled.version).toBe(started.version);
    expect(settled.steps).toBe(started.steps);
    expect(dropInviteeChoice(settled, 0, 'Sarah').drafts[0]).not.toHaveProperty('inviteeChoices');
    expect(dropInviteeChoice(settled, 3, 'Sarah')).toBe(settled);
  });
});

const figl = (source: string): PlaceCandidate => ({
  address: 'Wollzeile 5',
  geo: new GeoLocation({ lat: 48.209, lng: 16.375, name: 'Figlmüller', source }),
  match: 'words',
  source: 'mapkit',
});
const said = (location: string): QuickAddItem => ({
  kind: 'event',
  prefill: { ...dinner.prefill, location },
});

describe('places from the words', () => {
  const central: PlaceCandidate = {
    geo: new GeoLocation({ lat: 48.21, lng: 16.365, name: 'Café Central', source: 'Café Central' }),
    match: 'phonetic',
    source: 'history',
  };

  it('takes a past place without asking: the text becomes its, the pin with it, the text as said a chip away', () => {
    const state = startThread([said('Cafe Zentral')], 'dinner at Cafe Zentral', {
      id: ids(),
      place: { candidates: [central], text: 'Cafe Zentral' },
    });
    expect(state.drafts[0]).toMatchObject({
      extras: { attendees: [], geo: central.geo },
      item: { prefill: { location: 'Café Central' } },
      // Review: a lone taken place left no way back to the text as said.
      placeChoice: { candidates: [central], text: 'Cafe Zentral' },
    });
    // One place is no count worth saying.
    expect(phraseSteps(state)[0]?.summary).toBe('Dinner with Teo · Fri, Aug 28 · 19:00–20:00');
  });

  it('a place taken anew lets go of a text kept as said', () => {
    // Review: "As said" travels with the draft (a turn re-gives the text to
    // the form); a turn that moves the place must not carry it along.
    const kept = startThread([said('Figlmüller')], 'dinner at Figlmüller', {
      extras: {
        attendees: [],
        description: '',
        locationAsSaid: 'Figlmüller',
        reminders: undefined,
      },
      id: ids(),
    });
    expect(kept.drafts[0]?.extras?.locationAsSaid).toBe('Figlmüller');
    const moved = refineThread(
      kept,
      'at Cafe Zentral',
      [
        {
          id: 'd1',
          item: said('Cafe Zentral'),
          place: { candidates: [central], text: 'Cafe Zentral' },
        },
      ],
      ids(),
    );
    expect(moved.drafts[0]?.extras).toMatchObject({ geo: central.geo });
    expect(moved.drafts[0]?.extras?.locationAsSaid).toBeUndefined();
  });

  it('a turn that takes the place away takes its choice with it', () => {
    // Review: the old choice lingered, hidden, and came back with the same text retyped.
    const started = startThread([said('Figlmüller')], 'dinner at Figlmüller', {
      id: ids(),
      place: { candidates: [figl('A'), figl('B')], text: 'Figlmüller' },
    });
    const cleared = refineThread(
      started,
      'remove the location',
      [{ id: 'd1', item: dinner, place: { candidates: [], text: '' } }],
      ids(),
    );
    expect(cleared.drafts[0]).not.toHaveProperty('placeChoice');
  });

  it('takes the best of several and keeps the rest to pick from; a text nobody knows stays', () => {
    const two = [figl('Figlmüller, Wollzeile 5'), figl('Figlmüller, Bäckerstraße 6')];
    const state = startThread([said('Figlmüller')], 'dinner at Figlmüller', {
      id: ids(),
      place: { candidates: two, text: 'Figlmüller' },
    });
    expect(state.drafts[0]).toMatchObject({
      extras: { geo: two[0]!.geo },
      item: { prefill: { location: 'Figlmüller, Wollzeile 5' } },
      placeChoice: { candidates: two, text: 'Figlmüller' },
    });
    expect(phraseSteps(state)[0]?.summary).toContain('2 places');
    // A hit that does not resemble the text is offered, not taken.
    const other: PlaceCandidate = { ...figl('Kaffeeweg'), match: 'search' };
    const offered = startThread([said('Kaffee Sperl')], 'at Kaffee Sperl', {
      id: ids(),
      place: { candidates: [other], text: 'Kaffee Sperl' },
    });
    expect(offered.drafts[0]).toMatchObject({
      item: { prefill: { location: 'Kaffee Sperl' } },
      placeChoice: { candidates: [other] },
    });
    expect(offered.drafts[0]?.extras).toBeUndefined();
    expect(phraseSteps(offered)[0]?.summary).toContain('which “Kaffee Sperl”?');
    const none = startThread([said('Room 4')], 'dinner in Room 4', {
      id: ids(),
      place: { candidates: [], text: 'Room 4' },
    });
    expect(none.drafts[0]).not.toHaveProperty('placeChoice');
    expect(phraseSteps(none)[0]?.summary).not.toContain('which');
  });

  it('a turn that sets a place replaces the choice and says the place it took; Undo brings the choice back', () => {
    const started = startThread([said('Figlmüller')], 'dinner at Figlmüller', {
      id: ids(),
      place: { candidates: [figl('A'), figl('B')], text: 'Figlmüller' },
    });
    const moved = refineThread(
      started,
      'at Cafe Zentral instead',
      [
        {
          id: 'd1',
          item: said('Cafe Zentral'),
          place: { candidates: [central], text: 'Cafe Zentral' },
        },
      ],
      ids(),
    );
    expect(moved.drafts[0]).toMatchObject({
      item: { prefill: { location: 'Café Central' } },
      // The new turn's own row, the lone place taken on it.
      placeChoice: { candidates: [central], text: 'Cafe Zentral' },
    });
    // The summary names the place taken, not the text said.
    expect(phraseSteps(moved).at(-1)?.summary).toBe('→ Café Central');
    expect(undoTurn(moved).drafts[0]?.placeChoice?.text).toBe('Figlmüller');
    // A turn about something else keeps the choice.
    const kept = refineThread(
      started,
      'at 8',
      [
        {
          id: 'd1',
          item: { kind: 'event', prefill: { ...later.prefill, location: 'Figlmüller' } },
        },
      ],
      ids(),
    );
    expect(kept.drafts[0]?.placeChoice?.text).toBe('Figlmüller');
  });

  it('applies to the form while the location reads its text or one of its places', () => {
    // Review: an edited or cleared location kept the old chips, whose pick put the old place over it.
    const choice = {
      candidates: [figl('Figlmüller, A'), figl('Figlmüller, B')],
      text: 'Figlmüller',
    };
    expect(livePlaceChoice(choice, 'Figlmüller')).toBe(choice);
    expect(livePlaceChoice(choice, '  figlmüller ')).toBe(choice);
    expect(livePlaceChoice(choice, 'Figlmüller, B')).toBe(choice);
    const b = choice.candidates[1]!;
    expect(pickedCandidate(choice, 'Figlmüller, B', b.geo)).toBe(b);
    // Review: the text alone said nothing about the pin — held means the pin is its.
    expect(pickedCandidate(choice, 'Figlmüller, B', undefined)).toBeUndefined();
    expect(pickedCandidate(choice, 'Figlmüller', b.geo)).toBeUndefined();
    expect(readsAsSaid(choice, 'figlmüller', undefined)).toBe(true);
    // A past place whose text is the text as said is that chip, not "as said".
    const ownText = {
      candidates: [{ ...figl('Figlmüller'), source: 'history' as const }],
      text: 'Figlmüller',
    };
    const own = ownText.candidates[0]!;
    expect(readsAsSaid(ownText, 'Figlmüller', own.geo)).toBe(false);
    expect(pickedCandidate(ownText, 'Figlmüller', own.geo)).toBe(own);
    // …until the pin is let go: then it is the text as said.
    expect(readsAsSaid(ownText, 'Figlmüller', undefined)).toBe(true);
    expect(livePlaceChoice(choice, 'Figlmüller Lugeck')).toBeUndefined();
    expect(livePlaceChoice(choice, '')).toBeUndefined();
    expect(livePlaceChoice(undefined, 'Figlmüller')).toBeUndefined();
  });

  it('drops a choice settled by hand, without a turn or a version', () => {
    const started = startThread([said('Figlmüller')], 'dinner at Figlmüller', {
      id: ids(),
      place: { candidates: [figl('A'), figl('B')], text: 'Figlmüller' },
    });
    const settled = dropPlaceChoice(started, 0);
    expect(settled.drafts[0]).not.toHaveProperty('placeChoice');
    expect(settled.version).toBe(started.version);
    expect(settled.steps).toBe(started.steps);
    expect(dropPlaceChoice(settled, 0)).toBe(settled);
  });
});

const popup = (minutes: number) => new ReminderOverride({ method: 'popup', minutes });

describe('notes and notifications from the words', () => {
  const typed = { attendees: [], description: 'Bring wine', reminders: undefined };

  it('starts a draft with the phrase’s note after what was typed, and its notifications', () => {
    const state = startThread([dinner], 'dinner Friday at 7, note: ask about the trip', {
      extras: typed,
      id: ids(),
      notes: { kind: 'add', text: 'ask about the trip' },
      reminders: { add: [30], clear: false, remove: [] },
    });
    expect(state.drafts[0]?.extras).toEqual({
      attendees: [],
      description: 'Bring wine\nask about the trip',
      reminders: new EventReminders({ overrides: [popup(30)], useDefault: false }),
    });
    expect(phraseSteps(state)[0]?.summary).toBe(
      'Dinner with Teo · Fri, Aug 28 · 19:00–20:00 · adds a note · notifies 30 minutes before',
    );
    // A draft the form never held gets blank extras around them.
    const fresh = startThread([dinner], 'dinner, remind me an hour before', {
      id: ids(),
      reminders: { add: [60], clear: false, remove: [] },
    });
    expect(fresh.drafts[0]?.extras).toEqual({
      attendees: [],
      description: '',
      reminders: new EventReminders({ overrides: [popup(60)], useDefault: false }),
    });
  });

  it('gives a to-do its note as its own notes, and no notifications', () => {
    const todo: QuickAddItem = { kind: 'task', prefill: { date: '2026-08-28', title: 'Call Tom' } };
    const state = startThread([todo], 'call Tom, note: about the invoice', {
      id: ids(),
      notes: { kind: 'add', text: 'about the invoice' },
      reminders: { add: [30], clear: false, remove: [] },
    });
    expect(state.drafts[0]?.extras).toEqual({
      attendees: [],
      description: '',
      reminders: undefined,
      taskNotes: 'about the invoice',
    });
    expect(phraseSteps(state)[0]?.summary).toBe('Call Tom · Fri, Aug 28 · adds a note');
  });

  it('lands a turn’s note and notifications on the form as it is now, says so, and Undo takes them back', () => {
    const started = startThread([dinner], 'dinner', { extras: typed, id: ids() });
    // A notification picked while the model answered stays.
    const form = {
      extras: {
        ...typed,
        reminders: new EventReminders({ overrides: [popup(15)], useDefault: false }),
      },
      item: dinner,
    };
    const landed = landRefinement(started, {
      changes: [
        {
          id: 'd1',
          item: dinner,
          notes: { kind: 'add', text: 'ask about the trip' },
          reminders: { add: [60], clear: false, remove: [] },
        },
      ],
      fresh: form,
      submitted: { extras: typed, item: dinner },
      targetId: 'd1',
      utterance: 'note: ask about the trip, and an hour before as well',
    });
    expect(landed.drafts[0]?.extras).toEqual({
      attendees: [],
      description: 'Bring wine\nask about the trip',
      reminders: new EventReminders({ overrides: [popup(15), popup(60)], useDefault: false }),
    });
    expect(phraseSteps(landed).at(-1)?.summary).toBe('→ adds a note · → notifies 1 hour before');
    const undone = undoTurn(landed);
    expect(undone.drafts[0]?.extras).toEqual(form.extras);
  });

  it('a finder turn carries the note and notifications said with it onto the draft it places', () => {
    const started = startThread([dinner], 'dinner', { id: ids() });
    const slot = { date: '2026-08-31', endTime: '10:00', startTime: '09:00' };
    const placed = landPlacement(started, {
      notes: { kind: 'add', text: 'bring the deck' },
      reminders: { add: [10], clear: false, remove: [] },
      slots: [slot],
      targetId: 'd1',
      utterance: 'find an hour Monday morning, remind me 10 minutes before, note: bring the deck',
    });
    expect(placed.drafts[0]?.extras).toEqual({
      attendees: [],
      description: 'bring the deck',
      reminders: new EventReminders({ overrides: [popup(10)], useDefault: false }),
    });
    expect(phraseSteps(placed).at(-1)?.summary).toContain('notifies 10 minutes before');
  });

  it('says nothing for a removal that finds nothing to take off', () => {
    const started = startThread([dinner], 'dinner', { id: ids() });
    const moved = refineThread(
      started,
      'remove the 15 minute reminder',
      [{ id: 'd1', item: dinner, reminders: { add: [], clear: false, remove: [15] } }],
      ids(),
    );
    expect(moved.drafts[0]).not.toHaveProperty('extras');
    expect(phraseSteps(moved).at(-1)?.summary).toBe('no change');
  });
});

describe('a turn on a to-do the form holds undated', () => {
  const todo: QuickAddItem = {
    kind: 'task',
    prefill: { date: '2026-08-28', title: 'Call the bank' },
  };
  const extras = { attendees: [], description: '', reminders: undefined, undated: true };
  // A saved to-do without a due day: its thread opens holding that.
  const open = () => openThread({ extras, item: todo }, ids());
  const said = (prefill: Record<string, unknown>) =>
    refineThread(open(), 'x', [
      {
        id: 'd1',
        item: { kind: 'task', prefill: { ...todo.prefill, ...prefill } } as QuickAddItem,
      },
    ]);

  it('dates it when the words gave another day, and undates it again with Undo', () => {
    const landed = said({ date: '2026-08-29' });
    expect(landed.drafts[0]?.item.prefill.date).toBe('2026-08-29');
    expect(landed.drafts[0]?.extras?.undated).toBe(false);
    expect(undoTurn(landed).drafts[0]?.extras?.undated).toBe(true);
  });

  it('dates it when the words gave a time: that is due on the day it holds', () => {
    expect(said({ time: '17:00' }).drafts[0]?.extras?.undated).toBe(false);
  });

  it('leaves it undated when the words left the day and the time alone', () => {
    const landed = said({ title: 'Call the bank about the card' });
    expect(landed.drafts[0]?.extras?.undated).toBe(true);
    // The same through the form's reading, as a refinement lands.
    const merged = landRefinement(open(), {
      changes: [
        { id: 'd1', item: { kind: 'task', prefill: { ...todo.prefill, date: '2026-08-30' } } },
      ],
      fresh: { extras, item: todo },
      submitted: { extras, item: todo },
      targetId: 'd1',
      utterance: 'on Sunday',
    });
    expect(merged.drafts[0]?.extras?.undated).toBe(false);
  });
});

describe('a turn for a draft that is gone', () => {
  it('is no step: removed or saved while the model answered, nothing landed', () => {
    const state = startThread([dinner, planning], 'x', { id: ids() });
    const without = removeDraft(state, 0);
    const change = { id: 'd1', item: later };
    expect(refineThread(without, 'an hour later', [change])).toBe(without);
    expect(
      landRefinement(without, {
        changes: [change],
        fresh: { item: planning },
        submitted: { item: dinner },
        targetId: 'd1',
        utterance: 'an hour later',
      }),
    ).toBe(without);
    // A change for a draft still there lands, and only that one is counted.
    const both = refineThread(without, 'both an hour later', [
      change,
      { id: 'd2', item: { kind: 'event', prefill: { ...planning.prefill, startTime: '15:00' } } },
    ]);
    expect(both.steps).toHaveLength(without.steps.length + 1);
    expect(both.steps.at(-1)).toMatchObject({ drafts: ['d2'], kind: 'phrase' });
    expect(phraseSteps(both).at(-1)?.summary).not.toContain('2 drafts');
  });
});

/** An item's repeat rule; a to-do's item has none. */
const ruleOf = (item: QuickAddItem | undefined) =>
  item?.kind === 'event' ? item.prefill.recurrence : undefined;
/** A saved occurrence's thread, opened before its master was read: no rule yet. */
const opened = () => openThread({ item: dinner }, ids());

describe('reseedRule', () => {
  const weekly = { freq: 'weekly' } as const;

  it('gives a thread without steps the rule: "As saved" is the series', () => {
    const seeded = reseedRule(opened(), weekly);
    expect(ruleOf(seeded.drafts[0]?.item)).toEqual(weekly);
    expect(seeded.steps).toHaveLength(0);
  });

  it('gives it to every state that held the opened rule, back and ahead', () => {
    const moved = refineThread(opened(), 'an hour later', [{ id: 'd1', item: later }]);
    const titled = refineThread(moved, 'call it Supper', [
      { id: 'd1', item: { kind: 'event', prefill: { ...later.prefill, title: 'Supper' } } },
    ]);
    // One step back: a state behind, the one on show, one ahead.
    const seeded = reseedRule(stepTo(titled, 1), weekly);
    expect(ruleOf(seeded.history[0]?.drafts[0]?.item)).toEqual(weekly);
    expect(ruleOf(seeded.drafts[0]?.item)).toEqual(weekly);
    expect(ruleOf(seeded.ahead[0]?.after.drafts[0]?.item)).toEqual(weekly);
    // "As saved" kept is the series, rule and all.
    expect(ruleOf(keepShown(stepTo(seeded, 0)).drafts[0]?.item)).toEqual(weekly);
    // Nothing else moved: the steps, and what each state held.
    expect(seeded.steps).toEqual(stepTo(titled, 1).steps);
    expect(seeded.drafts[0]?.item.prefill).toMatchObject({ startTime: '20:00' });
  });

  it('leaves a state a step gave another rule', () => {
    const daily = rule({ freq: 'daily' });
    const ruled = refineThread(opened(), 'every day', [{ id: 'd1', item: daily }]);
    const seeded = reseedRule(ruled, weekly);
    expect(ruleOf(seeded.history[0]?.drafts[0]?.item)).toEqual(weekly);
    expect(ruleOf(seeded.drafts[0]?.item)).toEqual({ freq: 'daily' });
  });

  it('is the same state for the rule it opened with, a to-do or an empty thread', () => {
    const state = openThread({ item: rule({ freq: 'weekly' }) }, ids());
    expect(reseedRule(state, weekly)).toBe(state);
    expect(reseedRule(opened(), undefined)).toEqual(opened());
    const todo = openThread({
      item: { kind: 'task', prefill: { date: '2026-08-28', title: 'x' } },
    });
    expect(reseedRule(todo, weekly)).toBe(todo);
    expect(reseedRule(EMPTY_THREAD, weekly)).toBe(EMPTY_THREAD);
  });
});
