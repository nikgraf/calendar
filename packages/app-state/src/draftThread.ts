import { type LanguageModel, parseRefine } from '@calendar/ai';
import { type AttendeeInput, type EventReminders, Temporal } from '@calendar/core';
import { useRef, useState } from 'react';
import { convertQuickAddItem, type QuickAddItem } from './quickAddItem.ts';

/**
 * The thread behind a new item: what the user said, turn by turn, and the
 * drafts those words made. One phrase starts it (or a capture, with every
 * event a paste held); each later utterance refines the drafts — a change
 * is a new turn, never a new item — and Undo takes the last turn back.
 * The form shows the focused draft and the calendar draws them all, so a
 * draft is seen before anything is written; nothing is saved until Save.
 *
 * Pure state and transitions here, tested without React; `useDraftThread`
 * threads them into a hook with the model calls.
 */

/**
 * What the form holds of an event draft beyond its prefill — guests,
 * notes, notifications — kept per draft so they never follow the form to
 * the next draft, and written with it by "Add all".
 */
export interface DraftExtras {
  readonly attendees: ReadonlyArray<AttendeeInput>;
  readonly description: string;
  /** The notifications as edited; undefined while untouched (the calendar's default). */
  readonly reminders: EventReminders | undefined;
}

export interface Draft {
  /** Set once the form held the draft; absent for a draft the form never showed. */
  readonly extras?: DraftExtras | undefined;
  readonly id: string;
  readonly item: QuickAddItem;
}

export interface DraftTurn {
  readonly id: string;
  /** What the turn did to the drafts, in words — the thread's visible history. */
  readonly summary: string;
  readonly utterance: string;
}

interface Snapshot {
  readonly drafts: ReadonlyArray<Draft>;
  readonly focused: number;
}

export interface DraftThreadState extends Snapshot {
  /** The drafts as they were before each turn, oldest first: what Undo restores. */
  readonly history: ReadonlyArray<Snapshot>;
  readonly turns: ReadonlyArray<DraftTurn>;
  /**
   * Moves on every change the form must take over (a turn, an undo, a
   * focus, a removal) and stays on the form's own edits (`updateDraft`),
   * so a panel re-applies the focused draft exactly when it should.
   */
  readonly version: number;
}

export const EMPTY_THREAD: DraftThreadState = {
  drafts: [],
  focused: 0,
  history: [],
  turns: [],
  version: 0,
};

let counter = 0;
/** A fresh id for a draft or a turn; injectable so tests read stable ids. */
export const nextDraftId = (): string => {
  counter += 1;
  return `draft-${counter}`;
};

/** "Fri, Aug 28 · 19:00–20:00", "Fri, Aug 28" for an all-day event, "Tue, Aug 25 · 09:30" for a to-do. */
export const describeDraftItem = (item: QuickAddItem): string => {
  const day = Temporal.PlainDate.from(item.prefill.date).toLocaleString('en-US', {
    day: 'numeric',
    month: 'short',
    weekday: 'short',
  });
  if (item.kind === 'task') {
    return item.prefill.time === undefined ? day : `${day} · ${item.prefill.time}`;
  }
  return item.prefill.isAllDay ? day : `${day} · ${item.prefill.startTime}–${item.prefill.endTime}`;
};

const timesOf = (item: QuickAddItem): string =>
  item.kind === 'task'
    ? (item.prefill.time ?? 'no time')
    : item.prefill.isAllDay
      ? 'all day'
      : `${item.prefill.startTime}–${item.prefill.endTime}`;

const dayOf = (item: QuickAddItem): string =>
  Temporal.PlainDate.from(item.prefill.date).toLocaleString('en-US', {
    day: 'numeric',
    month: 'short',
    weekday: 'short',
  });

const repeatOf = (item: QuickAddItem): string | undefined =>
  item.kind === 'event' && item.prefill.recurrence
    ? `repeats ${item.prefill.recurrence.freq}`
    : undefined;

/**
 * What a refinement changed, field by field ("→ 20:00–21:00 · → Thu, Aug
 * 27"), or "no change" when the words changed nothing the form holds.
 */
export const summarizeChange = (before: QuickAddItem, after: QuickAddItem): string => {
  const parts: Array<string> = [];
  if (before.kind !== after.kind) {
    parts.push(`→ ${after.kind === 'task' ? 'a to-do' : 'an event'}`);
  }
  if (before.prefill.title !== after.prefill.title) {
    parts.push(`→ “${after.prefill.title}”`);
  }
  if (before.prefill.date !== after.prefill.date) {
    parts.push(`→ ${dayOf(after)}`);
  }
  if (timesOf(before) !== timesOf(after)) {
    parts.push(`→ ${timesOf(after)}`);
  }
  const placeBefore = before.kind === 'event' ? before.prefill.location : undefined;
  const placeAfter = after.kind === 'event' ? after.prefill.location : undefined;
  if (placeBefore !== placeAfter) {
    parts.push(placeAfter === undefined ? '→ no place' : `→ ${placeAfter}`);
  }
  if (repeatOf(before) !== repeatOf(after)) {
    parts.push(`→ ${repeatOf(after) ?? 'does not repeat'}`);
  }
  return parts.length === 0 ? 'no change' : parts.join(' · ');
};

/** The first turn: the phrase (or the paste) and every draft it made. */
export const startThread = (
  items: ReadonlyArray<QuickAddItem>,
  utterance: string,
  id: () => string = nextDraftId,
): DraftThreadState => {
  const drafts = items.map((item) => ({ id: id(), item }));
  const summary =
    drafts.length === 1 && drafts[0]
      ? `${drafts[0].item.prefill.title} · ${describeDraftItem(drafts[0].item)}`
      : `${String(drafts.length)} drafts`;
  return {
    drafts,
    focused: 0,
    history: [{ drafts: [], focused: 0 }],
    turns: [{ id: id(), summary, utterance }],
    version: 1,
  };
};

/**
 * The drafts an utterance addresses: all of them when it says so ("all",
 * "both", "alle", "beide"), else the focused one. A word like "every"
 * is left alone — "every week" is a repeat, not an address — and so is
 * the "all" of "all day".
 */
export const refineTargets = (state: DraftThreadState, utterance: string): ReadonlyArray<Draft> => {
  if (/\b(?:all(?![- ]day)|both|alle|beide)\b/i.test(utterance)) {
    return state.drafts;
  }
  const focused = state.drafts[state.focused];
  return focused ? [focused] : [];
};

/**
 * A turn's results folded in: the changed drafts replace their old
 * selves, the rest stay, and the state before goes to the history. The
 * summary lists what changed on the focused draft, or how many changed.
 */
export const refineThread = (
  state: DraftThreadState,
  utterance: string,
  changes: ReadonlyArray<{ readonly id: string; readonly item: QuickAddItem }>,
  id: () => string = nextDraftId,
): DraftThreadState => {
  const changed = new Map(changes.map((change) => [change.id, change.item]));
  const drafts = state.drafts.map((draft) => {
    const item = changed.get(draft.id);
    return item === undefined ? draft : { ...draft, item };
  });
  const focused = state.drafts[state.focused];
  const focusedChange = focused ? changed.get(focused.id) : undefined;
  const summary =
    focused && focusedChange
      ? changes.length > 1
        ? `${summarizeChange(focused.item, focusedChange)} (${String(changes.length)} drafts)`
        : summarizeChange(focused.item, focusedChange)
      : `${String(changes.length)} drafts changed`;
  return {
    drafts,
    focused: state.focused,
    history: [...state.history, { drafts: state.drafts, focused: state.focused }],
    turns: [...state.turns, { id: id(), summary, utterance }],
    version: state.version + 1,
  };
};

/** The last turn taken back; taking back the first one leaves no drafts. */
export const undoTurn = (state: DraftThreadState): DraftThreadState => {
  const previous = state.history.at(-1);
  if (previous === undefined) {
    return state;
  }
  return {
    drafts: previous.drafts,
    focused: Math.min(previous.focused, Math.max(previous.drafts.length - 1, 0)),
    history: state.history.slice(0, -1),
    turns: state.turns.slice(0, -1),
    version: state.version + 1,
  };
};

export const focusDraft = (state: DraftThreadState, index: number): DraftThreadState =>
  index >= 0 && index < state.drafts.length && index !== state.focused
    ? { ...state, focused: index, version: state.version + 1 }
    : state;

/**
 * The form's edits to the focused draft — its fields and what the form
 * holds beyond them — kept so a later turn starts from them and another
 * draft's turn in the form never shows them. Not a turn.
 */
export const updateDraft = (
  state: DraftThreadState,
  index: number,
  item: QuickAddItem,
  extras?: DraftExtras,
): DraftThreadState =>
  state.drafts[index] === undefined
    ? state
    : {
        ...state,
        drafts: state.drafts.map((draft, at) =>
          at === index ? { ...draft, ...(extras ? { extras } : {}), item } : draft,
        ),
      };

/** A snapshot without the drafts named, its focus clamped. */
const without = (snapshot: Snapshot, gone: ReadonlySet<string>): Snapshot => {
  const drafts = snapshot.drafts.filter((draft) => !gone.has(draft.id));
  const focusedId = snapshot.drafts[snapshot.focused]?.id;
  const kept = drafts.findIndex((draft) => draft.id === focusedId);
  return {
    drafts,
    focused: kept === -1 ? Math.min(snapshot.focused, Math.max(drafts.length - 1, 0)) : kept,
  };
};

/**
 * Drafts dropped by id, all at once (the ones "Add all" has written, or
 * one Save wrote). The focus follows its draft. The history loses them
 * too: a written draft must not come back through Undo, to be written
 * twice. The version moves only when the form must change — the focused
 * draft left, or none is left — never for another draft going.
 */
export const removeDrafts = (
  state: DraftThreadState,
  ids: ReadonlyArray<string>,
): DraftThreadState => {
  const gone = new Set(ids);
  if (!state.drafts.some((draft) => gone.has(draft.id))) {
    return state;
  }
  const focusedId = state.drafts[state.focused]?.id;
  const next = without(state, gone);
  const formChanges = focusedId === undefined || gone.has(focusedId) || next.drafts.length === 0;
  return {
    ...state,
    ...next,
    history: state.history.map((snapshot) => without(snapshot, gone)),
    version: formChanges ? state.version + 1 : state.version,
  };
};

/** A draft dropped from the thread (saved, or not wanted). Not a turn: nothing to undo into. */
export const removeDraft = (state: DraftThreadState, index: number): DraftThreadState => {
  const draft = state.drafts[index];
  return draft === undefined ? state : removeDrafts(state, [draft.id]);
};

/**
 * The thread as a hook: the state above, the model call for a turn, and
 * the stale-answer guard. A turn that lands after the thread was cleared
 * or another turn began is dropped; a form snapshot of the focused draft
 * (`focusedNow`) is folded in first, so a turn starts from what the user
 * sees and its summary lists only what the words changed.
 */
export const useDraftThread = ({ model, timeZone }: { model: LanguageModel; timeZone: string }) => {
  const [state, setState] = useState<DraftThreadState>(EMPTY_THREAD);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);

  const start = (items: ReadonlyArray<QuickAddItem>, utterance: string) => {
    request.current += 1;
    setState(startThread(items, utterance));
  };

  const refine = async (
    utterance: string,
    focusedNow?: QuickAddItem,
    extras?: DraftExtras,
  ): Promise<string | undefined> => {
    const mine = ++request.current;
    const current =
      focusedNow === undefined ? state : updateDraft(state, state.focused, focusedNow, extras);
    const focusedId = current.drafts[current.focused]?.id;
    const targets = refineTargets(current, utterance);
    if (targets.length === 0) {
      return 'Nothing to change yet.';
    }
    setBusy(true);
    try {
      const referenceDate = Temporal.Now.plainDateISO(timeZone).toString();
      const results = await Promise.all(
        targets.map(async (draft) => {
          // A to-do is refined as the event it would be, and read back as a to-do.
          const asEvent = convertQuickAddItem(draft.item, 'event');
          const result =
            asEvent.kind === 'event'
              ? await parseRefine(model, {
                  draft: asEvent.prefill,
                  referenceDate,
                  timeZone,
                  utterance,
                })
              : undefined;
          return { draft, result };
        }),
      );
      if (mine !== request.current) {
        return undefined;
      }
      const changes = results.flatMap(({ draft, result }) =>
        result?.kind === 'parsed'
          ? [
              {
                id: draft.id,
                item: convertQuickAddItem(
                  { kind: 'event', prefill: result.prefill },
                  draft.item.kind,
                ),
              },
            ]
          : [],
      );
      if (changes.length === 0) {
        const rejected = results.find(({ result }) => result?.kind === 'rejected')?.result;
        return rejected?.kind === 'rejected'
          ? rejected.reason
          : "That couldn't be read — try rephrasing.";
      }
      setState((latest) => {
        const index = latest.drafts.findIndex((draft) => draft.id === focusedId);
        const base =
          focusedNow !== undefined && index !== -1
            ? updateDraft(latest, index, focusedNow, extras)
            : latest;
        return refineThread(base, utterance, changes);
      });
      return undefined;
    } catch {
      return 'On-device model unavailable.';
    } finally {
      if (mine === request.current) {
        setBusy(false);
      }
    }
  };

  return {
    busy,
    clear: () => {
      request.current += 1;
      setState(EMPTY_THREAD);
    },
    focus: (index: number) => setState((latest) => focusDraft(latest, index)),
    refine,
    remove: (index: number) => setState((latest) => removeDraft(latest, index)),
    removeMany: (ids: ReadonlyArray<string>) => setState((latest) => removeDrafts(latest, ids)),
    start,
    state,
    undo: () => {
      request.current += 1;
      setState((latest) => undoTurn(latest));
    },
    update: (index: number, item: QuickAddItem, extras?: DraftExtras) =>
      setState((latest) => updateDraft(latest, index, item, extras)),
  };
};
