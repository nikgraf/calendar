import {
  isFinderPhrase,
  type LanguageModel,
  NO_SLOT_FITS,
  parseQuickAdd,
  parseRefine,
  proposeSlots,
} from '@calendar/ai';
import {
  type AttendeeInput,
  type BackendClient,
  type EventReminders,
  type FreeSlot,
  type GeoLocation,
  minutesBetween,
  Temporal,
} from '@calendar/core';
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
  /** Coordinates picked for the location text, while they still match it. */
  readonly geo?: GeoLocation | undefined;
  /** The notifications as edited; undefined while untouched (the calendar's default). */
  readonly reminders: EventReminders | undefined;
  /** A to-do's notes, when the form showed the draft as one. */
  readonly taskNotes?: string | undefined;
  /** A to-do whose due day the form let go of: its stored day is a placeholder. */
  readonly undated?: boolean | undefined;
}

export interface Draft {
  /** Set once the form held the draft; absent for a draft the form never showed. */
  readonly extras?: DraftExtras | undefined;
  readonly id: string;
  readonly item: QuickAddItem;
  /**
   * The free slots a finder phrase found for the draft, best first, the
   * draft sitting in one of them: the form offers them as chips, the grid
   * draws the others as candidates. Found for that phrase's constraints,
   * so the next turn drops them (Undo brings them back).
   */
  readonly slots?: ReadonlyArray<FreeSlot> | undefined;
}

/**
 * What a turn did to one draft: its item as it should be, the slots found
 * for it (if any), and its extras where the turn changed them (a to-do
 * placed in a slot is dated) — so the state before the turn, which Undo
 * restores, is the one the thread held.
 */
export interface DraftChange {
  readonly extras?: DraftExtras | undefined;
  readonly id: string;
  readonly item: QuickAddItem;
  readonly slots?: ReadonlyArray<FreeSlot> | undefined;
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

const placeOf = (item: QuickAddItem): string | undefined =>
  item.kind === 'event' ? item.prefill.location : undefined;

const ruleOf = (item: QuickAddItem): string =>
  item.kind === 'event' ? JSON.stringify(item.prefill.recurrence ?? null) : 'null';

/** A part of the form a turn can change: what the summary names and the form flashes. */
export type DraftField = 'date' | 'kind' | 'location' | 'repeat' | 'time' | 'title';

/** The fields that differ between two items, in the order the summary names them. */
export const changedDraftFields = (
  before: QuickAddItem,
  after: QuickAddItem,
): ReadonlyArray<DraftField> => [
  ...(before.kind === after.kind ? [] : ['kind' as const]),
  ...(before.prefill.title === after.prefill.title ? [] : ['title' as const]),
  ...(before.prefill.date === after.prefill.date ? [] : ['date' as const]),
  ...(timesOf(before) === timesOf(after) ? [] : ['time' as const]),
  ...(placeOf(before) === placeOf(after) ? [] : ['location' as const]),
  ...(ruleOf(before) === ruleOf(after) ? [] : ['repeat' as const]),
];

/**
 * What a refinement changed, field by field ("→ 20:00–21:00 · → Thu, Aug
 * 27"), or "no change" when the words changed nothing the form holds.
 */
export const summarizeChange = (before: QuickAddItem, after: QuickAddItem): string => {
  const said: Record<DraftField, () => string> = {
    date: () => `→ ${dayOf(after)}`,
    kind: () => `→ ${after.kind === 'task' ? 'a to-do' : 'an event'}`,
    location: () => {
      const place = placeOf(after);
      return place === undefined ? '→ no place' : `→ ${place}`;
    },
    repeat: () => `→ ${repeatOf(after) ?? 'does not repeat'}`,
    time: () => `→ ${timesOf(after)}`,
    title: () => `→ “${after.prefill.title}”`,
  };
  const parts = changedDraftFields(before, after).map((field) => said[field]());
  return parts.length === 0 ? 'no change' : parts.join(' · ');
};

/** "… · 3 free slots" when a turn found alternatives beside the draft's own. */
const withSlots = (summary: string, slots: ReadonlyArray<FreeSlot> | undefined): string =>
  slots && slots.length > 1 ? `${summary} · ${String(slots.length)} free slots` : summary;

export interface StartOptions {
  /** What the form already held: the first draft's. */
  readonly extras?: DraftExtras | undefined;
  readonly id?: (() => string) | undefined;
  /** A finder phrase's slots: the first draft's (it sits in the best one). */
  readonly slots?: ReadonlyArray<FreeSlot> | undefined;
}

/**
 * The first turn: the phrase (or the paste) and every draft it made. What
 * the form already held (guests typed before the phrase) goes with the
 * draft — a phrase makes one draft, so the extras are its, as are the
 * slots a finder phrase found.
 */
export const startThread = (
  items: ReadonlyArray<QuickAddItem>,
  utterance: string,
  { extras, id = nextDraftId, slots }: StartOptions = {},
): DraftThreadState => {
  const drafts = items.map((item, index) => ({
    ...(extras ? { extras } : {}),
    id: id(),
    item,
    ...(index === 0 && slots ? { slots } : {}),
  }));
  const summary =
    drafts.length === 1 && drafts[0]
      ? withSlots(
          `${drafts[0].item.prefill.title || 'Untitled'} · ${describeDraftItem(drafts[0].item)}`,
          slots,
        )
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

/** The draft without the slots a turn found for it. */
const withoutSlots = ({ slots: _slots, ...draft }: Draft): Draft => draft;

/**
 * A turn's results folded in: the changed drafts replace their old
 * selves, the rest stay, and the state before goes to the history. A
 * changed draft keeps slots only when the turn brings its own — the old
 * ones were found for other words. The summary lists what changed on
 * the focused draft, or how many changed.
 */
export const refineThread = (
  state: DraftThreadState,
  utterance: string,
  changes: ReadonlyArray<DraftChange>,
  id: () => string = nextDraftId,
): DraftThreadState => {
  const changed = new Map(changes.map((change) => [change.id, change]));
  const drafts = state.drafts.map((draft) => {
    const change = changed.get(draft.id);
    return change === undefined
      ? draft
      : {
          ...withoutSlots(draft),
          ...(change.extras ? { extras: change.extras } : {}),
          item: change.item,
          ...(change.slots ? { slots: change.slots } : {}),
        };
  });
  const focused = state.drafts[state.focused];
  const focusedChange = focused ? changed.get(focused.id) : undefined;
  const summary =
    focused && focusedChange
      ? withSlots(
          changes.length > 1
            ? `${summarizeChange(focused.item, focusedChange.item)} (${String(changes.length)} drafts)`
            : summarizeChange(focused.item, focusedChange.item),
          focusedChange.slots,
        )
      : `${String(changes.length)} drafts changed`;
  return {
    drafts,
    focused: state.focused,
    history: [...state.history, { drafts: state.drafts, focused: state.focused }],
    turns: [...state.turns, { id: id(), summary, utterance }],
    version: state.version + 1,
  };
};

/**
 * The item moved into a free slot: an event takes the slot's day and
 * times (timed, its default-time mark gone), a to-do is due at the slot's
 * start. A nameless item takes the title the phrase gave, if any.
 */
export const itemAtSlot = (item: QuickAddItem, slot: FreeSlot, title?: string): QuickAddItem => {
  const named = item.prefill.title.trim() === '' && title ? title : item.prefill.title;
  if (item.kind === 'task') {
    return {
      kind: 'task',
      prefill: { ...item.prefill, date: slot.date, time: slot.startTime, title: named },
    };
  }
  const { assumedTime: _assumed, ...prefill } = item.prefill;
  return {
    kind: 'event',
    prefill: {
      ...prefill,
      date: slot.date,
      endTime: slot.endTime,
      isAllDay: false,
      startTime: slot.startTime,
      title: named,
    },
  };
};

/** A new event draft in a free slot, titled as the phrase said, if it said. */
export const slotItem = (slot: FreeSlot, title?: string): QuickAddItem => ({
  kind: 'event',
  prefill: {
    date: slot.date,
    endTime: slot.endTime,
    isAllDay: false,
    startTime: slot.startTime,
    title: title ?? '',
  },
});

/** Whether an event item sits in the slot: the chosen one among a draft's proposals. */
export const isAtSlot = (item: QuickAddItem, slot: FreeSlot): boolean =>
  item.kind === 'event' &&
  !item.prefill.isAllDay &&
  item.prefill.date === slot.date &&
  item.prefill.startTime === slot.startTime &&
  item.prefill.endTime === slot.endTime;

/** A prefill field by field: the two kinds share no keys but the ones compared. */
const fields = (item: QuickAddItem): Record<string, unknown> =>
  item.prefill as unknown as Record<string, unknown>;

/**
 * A turn's result folded into the form as it is now, not as it was when
 * the turn was sent: the fields the turn changed are the result's, the
 * rest the form's — an edit made while the model was answering stays.
 */
export const mergeRefinement = (
  fresh: QuickAddItem,
  before: QuickAddItem,
  after: QuickAddItem,
): QuickAddItem => {
  if (fresh.kind !== before.kind || before.kind !== after.kind) {
    return after;
  }
  const changed = (field: string): boolean =>
    JSON.stringify(fields(before)[field]) !== JSON.stringify(fields(after)[field]);
  const merged: Record<string, unknown> = { ...fields(fresh) };
  for (const field of new Set([...Object.keys(fields(before)), ...Object.keys(fields(after))])) {
    if (changed(field)) {
      const value = fields(after)[field];
      if (value === undefined) {
        delete merged[field];
      } else {
        merged[field] = value;
      }
    }
  }
  return { kind: after.kind, prefill: merged } as unknown as QuickAddItem;
};

/** What the form holds of the focused draft at one moment: its item and extras. */
export interface FormSnapshot {
  readonly extras?: DraftExtras | undefined;
  readonly item: QuickAddItem;
}

/**
 * A refinement's changes folded in once the model answered. The form as
 * it is now (`fresh`) goes into the draft it shows first — the target
 * while that is still the focused one, else the draft focused meanwhile,
 * whose edits the turn's re-apply would otherwise wipe. Then the change
 * lands on the target: on the form's copy when it is the focused draft,
 * edits made while the model answered kept, else on its stored copy —
 * what the form held when it left — and only what the turn changed is
 * taken over.
 */
export const landRefinement = (
  state: DraftThreadState,
  {
    changes,
    fresh,
    submitted,
    targetId,
    utterance,
  }: {
    readonly changes: ReadonlyArray<DraftChange>;
    /** The form now, if it was read. */
    readonly fresh?: FormSnapshot | undefined;
    /** The form when the turn was sent, if it was read. */
    readonly submitted?: FormSnapshot | undefined;
    readonly targetId: string | undefined;
    readonly utterance: string;
  },
): DraftThreadState => {
  const index = state.drafts.findIndex((draft) => draft.id === targetId);
  if (submitted === undefined || fresh === undefined || index === -1) {
    return refineThread(state, utterance, changes);
  }
  const base = updateDraft(state, state.focused, fresh.item, fresh.extras);
  const current = base.drafts[index]!.item;
  return refineThread(
    base,
    utterance,
    changes.map((change) =>
      change.id === targetId
        ? { ...change, item: mergeRefinement(current, submitted.item, change.item) }
        : change,
    ),
  );
};

/**
 * A finder turn's slots folded in: the form as it is now goes into the
 * draft it shows (as above), then the target draft moves into the best
 * slot — its title kept, the slots on it. A to-do placed in a slot is
 * dated: an undated state the form held goes (and comes back with Undo).
 */
export const landPlacement = (
  state: DraftThreadState,
  {
    fresh,
    slots,
    targetId,
    title,
    utterance,
  }: {
    readonly fresh?: FormSnapshot | undefined;
    readonly slots: ReadonlyArray<FreeSlot>;
    readonly targetId: string;
    readonly title?: string | undefined;
    readonly utterance: string;
  },
): DraftThreadState => {
  const index = state.drafts.findIndex((draft) => draft.id === targetId);
  const [best] = slots;
  if (index === -1 || best === undefined) {
    return state;
  }
  const based =
    fresh === undefined ? state : updateDraft(state, state.focused, fresh.item, fresh.extras);
  const draft = based.drafts[index]!;
  return refineThread(based, utterance, [
    {
      ...(draft.extras?.undated ? { extras: { ...draft.extras, undated: false } } : {}),
      id: draft.id,
      item: itemAtSlot(draft.item, best, title),
      slots,
    },
  ]);
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

/** What the form holds of the focused draft, read by a turn before and after its model call. */
export type ReadForm = () => FormSnapshot;

/**
 * What the form held before the first phrase, as the first draft keeps
 * it: guests, notes, notifications — but not an undated to-do's state.
 * The phrase dates the draft (quick-add always did); an inbox add opened
 * undated must not clear the day the words gave ("call the bank
 * tomorrow"). Undefined stays undefined.
 */
export const firstDraftExtras = (extras: DraftExtras | undefined): DraftExtras | undefined => {
  if (extras === undefined) {
    return undefined;
  }
  const { undated: _undated, ...kept } = extras;
  return kept;
};

/** A finder phrase on an all-day draft, or none: the length searched for. */
const DEFAULT_SLOT_MINUTES = 60;

/**
 * The thread as a hook: the state above, what a phrase does (`phrase`:
 * the router, quick-add for a first phrase, a refinement for a later one,
 * slot proposals for one that asks for free time), and the stale-answer
 * guard. A turn that lands after the thread was cleared or another turn
 * began is dropped; a form snapshot of the focused draft (`read`) is
 * folded in first, so a turn starts from what the user sees and its
 * summary lists only what the words changed.
 */
export const useDraftThread = ({
  backend,
  model,
  timeZone,
}: {
  /** The events a finder phrase searches between. */
  backend: BackendClient;
  model: LanguageModel;
  timeZone: string;
}) => {
  const [state, setState] = useState<DraftThreadState>(EMPTY_THREAD);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);

  const start = (items: ReadonlyArray<QuickAddItem>, utterance: string, options?: StartOptions) => {
    request.current += 1;
    setState(startThread(items, utterance, options));
  };

  /**
   * A turn. `read` gives the form's current item and extras: once before
   * the model call (what the turn starts from) and once after (what the
   * form holds by then), so an edit made meanwhile is kept and only what
   * the turn changed is taken over (`mergeRefinement`).
   */
  const refine = async (utterance: string, read?: ReadForm): Promise<string | undefined> => {
    // A draft focused meanwhile is not where the answer lands (`landRefinement`).
    const mine = ++request.current;
    const submitted = read?.();
    const current =
      submitted === undefined
        ? state
        : updateDraft(state, state.focused, submitted.item, submitted.extras);
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
      const fresh = read?.();
      setState((latest) =>
        landRefinement(latest, { changes, fresh, submitted, targetId: focusedId, utterance }),
      );
      return undefined;
    } catch {
      return 'On-device model unavailable.';
    } finally {
      if (mine === request.current) {
        setBusy(false);
      }
    }
  };

  /**
   * A finder phrase: the free slots it finds, the best one as the draft.
   * With no draft yet a new event draft sits in it, titled as the phrase
   * said (if it said); otherwise the focused draft moves there, its title
   * kept and its own length searched for unless the phrase states one. The
   * slots go with the draft for the form to offer; the next turn drops them.
   */
  const place = async (utterance: string, read?: ReadForm): Promise<string | undefined> => {
    const mine = ++request.current;
    const submitted = read?.();
    const current =
      submitted === undefined
        ? state
        : updateDraft(state, state.focused, submitted.item, submitted.extras);
    const target = current.drafts[current.focused];
    const length =
      target?.item.kind === 'event' && !target.item.prefill.isAllDay
        ? minutesBetween(target.item.prefill.startTime, target.item.prefill.endTime)
        : 0;
    setBusy(true);
    try {
      const result = await proposeSlots(model, backend, {
        fallbackDurationMinutes: length > 0 ? length : DEFAULT_SLOT_MINUTES,
        phrase: utterance,
        referenceDate: Temporal.Now.plainDateISO(timeZone).toString(),
        timeZone,
      });
      if (mine !== request.current) {
        return undefined;
      }
      if (result.kind === 'rejected') {
        return result.reason;
      }
      const [best] = result.slots;
      if (best === undefined) {
        return NO_SLOT_FITS;
      }
      if (target === undefined) {
        const extras = firstDraftExtras(read?.().extras);
        setState(
          startThread([slotItem(best, result.title)], utterance, { extras, slots: result.slots }),
        );
        return undefined;
      }
      const fresh = read?.();
      setState((latest) =>
        landPlacement(latest, {
          fresh,
          slots: result.slots,
          targetId: target.id,
          title: result.title,
          utterance,
        }),
      );
      return undefined;
    } catch {
      return 'On-device model unavailable.';
    } finally {
      if (mine === request.current) {
        setBusy(false);
      }
    }
  };

  /**
   * What a phrase in the field does: one that asks for free time proposes
   * slots (`isFinderPhrase`, read by the code, so a phrase never has to
   * say which it is); otherwise the first phrase makes the draft(s)
   * through quick-add — what the form held before it goes with them — and
   * every later one refines. Resolves the message for the field, or
   * nothing when the phrase was taken. A model that cannot answer throws.
   */
  const phrase = async (
    text: string,
    {
      fallbackDate,
      read,
    }: {
      /** Where an undated first phrase lands (the day being viewed). */
      readonly fallbackDate: string;
      readonly read?: ReadForm | undefined;
    },
  ): Promise<string | undefined> => {
    if (isFinderPhrase(text)) {
      return place(text, read);
    }
    if (state.drafts.length > 0) {
      return refine(text, read);
    }
    const mine = request.current;
    const result = await parseQuickAdd(model, {
      fallbackDate,
      phrase: text,
      referenceDate: Temporal.Now.plainDateISO(timeZone).toString(),
      timeZone,
    });
    // Cleared or undone meanwhile: a draft from before must not come back.
    if (mine !== request.current) {
      return undefined;
    }
    if (result.kind === 'rejected') {
      return result.reason;
    }
    start(
      [
        result.kind === 'task'
          ? { kind: 'task', prefill: result.prefill }
          : { kind: 'event', prefill: result.prefill },
      ],
      text,
      { extras: firstDraftExtras(read?.().extras) },
    );
    return undefined;
  };

  return {
    busy,
    clear: () => {
      request.current += 1;
      setState(EMPTY_THREAD);
    },
    focus: (index: number) => setState((latest) => focusDraft(latest, index)),
    phrase,
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
