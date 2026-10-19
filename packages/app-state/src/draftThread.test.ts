import { describe, expect, it } from 'vite-plus/test';
import {
  changedDraftFields,
  describeDraftItem,
  dropInviteeChoice,
  dropPlaceChoice,
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
import { Contact, GeoLocation, type PlaceCandidate } from '@calendar/core';
import { livePlaceChoice, pickedCandidate, readsAsSaid } from './draftPlaces.ts';
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
    expect(state.turns[0]?.summary).toBe(
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
    expect(state.turns[0]?.summary).toBe('Call Tom · Fri, Aug 28');
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
    expect(landed.turns.at(-1)?.summary).toBe(
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
    expect(moved.turns.at(-1)?.summary).toBe('→ 20:00–21:00');
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
    expect(settled.turns).toBe(started.turns);
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

  it('takes a past place without asking: the text becomes its, the pin with it', () => {
    const state = startThread([said('Cafe Zentral')], 'dinner at Cafe Zentral', {
      id: ids(),
      place: { candidates: [central], text: 'Cafe Zentral' },
    });
    expect(state.drafts[0]).toMatchObject({
      extras: { attendees: [], geo: central.geo },
      item: { prefill: { location: 'Café Central' } },
    });
    expect(state.drafts[0]).not.toHaveProperty('placeChoice');
    expect(state.turns[0]?.summary).toBe('Dinner with Teo · Fri, Aug 28 · 19:00–20:00');
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
    expect(state.turns[0]?.summary).toContain('2 places');
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
    expect(offered.turns[0]?.summary).toContain('which “Kaffee Sperl”?');
    const none = startThread([said('Room 4')], 'dinner in Room 4', {
      id: ids(),
      place: { candidates: [], text: 'Room 4' },
    });
    expect(none.drafts[0]).not.toHaveProperty('placeChoice');
    expect(none.turns[0]?.summary).not.toContain('which');
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
    expect(moved.drafts[0]).toMatchObject({ item: { prefill: { location: 'Café Central' } } });
    expect(moved.drafts[0]).not.toHaveProperty('placeChoice');
    // The summary names the place taken, not the text said.
    expect(moved.turns.at(-1)?.summary).toBe('→ Café Central');
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
    expect(pickedCandidate(choice, 'Figlmüller, B')).toBe(choice.candidates[1]);
    expect(pickedCandidate(choice, 'Figlmüller')).toBeUndefined();
    expect(readsAsSaid(choice, 'figlmüller')).toBe(true);
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
    expect(settled.turns).toBe(started.turns);
    expect(dropPlaceChoice(settled, 0)).toBe(settled);
  });
});
