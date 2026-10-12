import { describe, expect, it } from 'vite-plus/test';
import {
  describeDraftItem,
  EMPTY_THREAD,
  firstDraftExtras,
  focusDraft,
  isAtSlot,
  itemAtSlot,
  landPlacement,
  landRefinement,
  mergeRefinement,
  refineTargets,
  refineThread,
  removeDraft,
  removeDrafts,
  slotItem,
  startThread,
  summarizeChange,
  undoTurn,
  updateDraft,
} from './draftThread.ts';
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
    expect(state.turns).toEqual([
      { id: 'd3', summary: '2 drafts', utterance: 'Dinner with Teo Friday, planning Saturday' },
    ]);
    // Undo of the first turn leads to nothing.
    expect(state.history).toEqual([{ drafts: [], focused: 0 }]);
  });

  it('describes a single draft in its first turn', () => {
    const state = startThread([dinner], 'Dinner with Teo next Friday', { id: ids() });
    expect(state.turns[0]?.summary).toBe('Dinner with Teo · Fri, Aug 28 · 19:00–20:00');
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
    expect(refined.turns.at(-1)).toEqual({ id: 'd4', summary: '→ 20:00–21:00', utterance: 'at 8' });
    expect(refined.history).toHaveLength(2);

    const undone = undoTurn(refined);
    expect(undone.drafts.map((draft) => draft.item)).toEqual([dinner, planning]);
    expect(undone.turns).toHaveLength(1);
    // The first turn taken back: an empty thread.
    const empty = undoTurn(undone);
    expect(empty.drafts).toEqual([]);
    expect(empty.turns).toEqual([]);
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
    expect(refined.turns.at(-1)?.summary).toBe('→ 20:00–21:00 (2 drafts)');
  });

  it('restores the focus the turn started with', () => {
    const id = ids();
    const focused = focusDraft(startThread([dinner, planning], 'x', { id }), 1);
    const refined = refineThread(focused, 'at 8', [{ id: 'd2', item: later }], id);
    expect(undoTurn(focusDraft(refined, 0)).focused).toBe(1);
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
    expect(edited.turns).toEqual(state.turns);
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
    expect(undone.turns).toHaveLength(1);
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
    expect(state.turns[0]?.summary).toBe('Focus · Fri, Aug 28 · 10:00–10:30 · 3 free slots');
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
    expect(placed.turns.at(-1)?.summary).toBe('→ 10:00–10:30 · 3 free slots');

    const moved = refineThread(placed, 'at 8', [{ id: 'd1', item: later }], id);
    expect(moved.drafts[0]).not.toHaveProperty('slots');
    expect(undoTurn(moved).drafts[0]?.slots).toEqual(slots);
  });

  it('a form edit keeps the slots', () => {
    const state = startThread([dinner], 'x', { id: ids(), slots });
    expect(updateDraft(state, 0, later).drafts[0]?.slots).toEqual(slots);
  });

  it('a single slot is no row: the summary stays plain', () => {
    const state = startThread([dinner], 'x', { id: ids(), slots: slots.slice(0, 1) });
    expect(state.turns[0]?.summary).toBe('Dinner with Teo · Fri, Aug 28 · 19:00–20:00');
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
