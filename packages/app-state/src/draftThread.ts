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
  draftMinutes,
  type PlaceCandidate,
  Temporal,
} from '@calendar/core';
import { Effect } from 'effect';
import { useRef, useState } from 'react';
import {
  applyGuestChange,
  type GuestChange,
  guestLabel,
  type InviteeChoice,
  resolveInvitees,
} from './draftInvitees.ts';
import { type PlaceChange, type PlaceChoice, settlePlace } from './draftPlaces.ts';
import { convertQuickAddItem, type QuickAddItem } from './quickAddItem.ts';
import type { ReminderFields } from './taskEditorModel.ts';

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
 * What the form holds of a draft beyond its prefill — guests, notes,
 * notifications, the calendar or list picked, a to-do's own fields —
 * kept per draft so they never follow the form to the next draft, and
 * written with it by "Add all".
 */
export interface DraftExtras {
  readonly attendees: ReadonlyArray<AttendeeInput>;
  /** The calendar picked for the draft (`accountId:calendarId`), when the form showed it as an event. */
  readonly calendarKey?: string | undefined;
  readonly description: string;
  /** Coordinates picked for the location text, while they still match it. */
  readonly geo?: GeoLocation | undefined;
  /** The list picked for the draft (`accountId:listId`), when the form showed it as a to-do. */
  readonly listKey?: string | undefined;
  /** A to-do's Reminders-only fields, when the form showed the draft as one. */
  readonly reminder?: ReminderFields | undefined;
  /** The notifications as edited; undefined while untouched (the calendar's default). */
  readonly reminders: EventReminders | undefined;
  /** A to-do's notes, when the form showed the draft as one. */
  readonly taskNotes?: string | undefined;
  /** A to-do whose due day the form let go of: its stored day is a placeholder. */
  readonly undated?: boolean | undefined;
}

export interface Draft {
  /** Set once the form held the draft (or a turn gave it guests); absent for a draft the form never showed. */
  readonly extras?: DraftExtras | undefined;
  readonly id: string;
  /**
   * Names the words invited that found no one contact, for the user to
   * pick from (`draftInvitees.ts`). They stay until picked, dismissed or
   * said again; Undo brings back the ones a turn settled.
   */
  readonly inviteeChoices?: ReadonlyArray<InviteeChoice> | undefined;
  readonly item: QuickAddItem;
  /**
   * The places the last turn's location text could mean, for the user to
   * pick from (`draftPlaces.ts`) — the one taken marked. It stays until
   * dismissed, or a turn sets another place; Undo brings back the one a
   * turn settled.
   */
  readonly placeChoice?: PlaceChoice | undefined;
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
  /** Whom the turn invited or took off: applied to the draft's guests as they are when it lands. */
  readonly guests?: GuestChange | undefined;
  readonly id: string;
  readonly item: QuickAddItem;
  /** What the turn's location text could mean: a place taken, a choice left, or nothing. */
  readonly place?: PlaceChange | undefined;
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

const dayLabel = (date: string): string =>
  Temporal.PlainDate.from(date).toLocaleString('en-US', {
    day: 'numeric',
    month: 'short',
    weekday: 'short',
  });

/** The day an event draft ends on, when it is not the day it starts. */
const lastDayOf = (item: QuickAddItem): string | undefined =>
  item.kind === 'event' &&
  item.prefill.endDate !== undefined &&
  item.prefill.endDate !== item.prefill.date
    ? item.prefill.endDate
    : undefined;

/**
 * "Fri, Aug 28 · 19:00–20:00", "Fri, Aug 28" for an all-day event, "Tue,
 * Aug 25 · 09:30" for a to-do; a draft over several days names both
 * ("Fri, Aug 28 – Sun, Aug 30", "Fri, Aug 28 · 23:00 – Sat, Aug 29 · 01:00").
 */
export const describeDraftItem = (item: QuickAddItem): string => {
  const day = dayLabel(item.prefill.date);
  if (item.kind === 'task') {
    return item.prefill.time === undefined ? day : `${day} · ${item.prefill.time}`;
  }
  const last = lastDayOf(item);
  if (last !== undefined) {
    return item.prefill.isAllDay
      ? `${day} – ${dayLabel(last)}`
      : `${day} · ${item.prefill.startTime} – ${dayLabel(last)} · ${item.prefill.endTime}`;
  }
  return item.prefill.isAllDay ? day : `${day} · ${item.prefill.startTime}–${item.prefill.endTime}`;
};

const timesOf = (item: QuickAddItem): string =>
  item.kind === 'task'
    ? (item.prefill.time ?? 'no time')
    : item.prefill.isAllDay
      ? 'all day'
      : `${item.prefill.startTime}–${item.prefill.endTime}`;

const dayOf = (item: QuickAddItem): string => {
  const last = lastDayOf(item);
  return last === undefined
    ? dayLabel(item.prefill.date)
    : `${dayLabel(item.prefill.date)} – ${dayLabel(last)}`;
};

const repeatOf = (item: QuickAddItem): string | undefined =>
  item.kind === 'event' && item.prefill.recurrence
    ? `repeats ${item.prefill.recurrence.freq}`
    : undefined;

const placeOf = (item: QuickAddItem): string | undefined =>
  item.kind === 'event' ? item.prefill.location : undefined;

/**
 * A repeat rule by its values, whatever order its parts were written in
 * (the form and the model's answer list them differently): an interval of
 * one is the default, the weekdays a set.
 */
const ruleOf = (item: QuickAddItem): string => {
  const rule = item.kind === 'event' ? item.prefill.recurrence : undefined;
  return rule === undefined
    ? 'none'
    : JSON.stringify([
        rule.freq,
        rule.interval ?? 1,
        rule.count ?? null,
        rule.untilDate ?? null,
        (rule.byDay ?? []).map((day) => `${String(day.ordinal ?? '')}${day.weekday}`).sort(),
      ]);
};

/** A part of the form a turn can change: what the summary names and the form flashes. */
export type DraftField = 'date' | 'kind' | 'location' | 'repeat' | 'time' | 'title';

/** The fields that differ between two items, in the order the summary names them. */
export const changedDraftFields = (
  before: QuickAddItem,
  after: QuickAddItem,
): ReadonlyArray<DraftField> => [
  ...(before.kind === after.kind ? [] : ['kind' as const]),
  ...(before.prefill.title === after.prefill.title ? [] : ['title' as const]),
  ...(before.prefill.date === after.prefill.date && lastDayOf(before) === lastDayOf(after)
    ? []
    : ['date' as const]),
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

/** What a draft holds beyond its item before the form ever showed it: nothing. */
const BLANK_EXTRAS: DraftExtras = { attendees: [], description: '', reminders: undefined };

/**
 * A turn's guests folded into a draft: its guest list (on its extras,
 * blank ones for a draft the form never held) and its open choices, plus
 * what changed in words — "invites Tom Baker", "uninvites Anna", "which
 * Tom?", "no contact “Sarah”".
 */
const withGuests = (
  draft: Draft,
  change: GuestChange | undefined,
): { readonly draft: Draft; readonly said: ReadonlyArray<string> } => {
  if (change === undefined || draft.item.kind !== 'event') {
    return { draft, said: [] };
  }
  const extras = draft.extras ?? BLANK_EXTRAS;
  const { added, attendees, choices, removed } = applyGuestChange(
    extras.attendees,
    draft.inviteeChoices ?? [],
    change,
  );
  const said = [
    ...(added.length > 0 ? [`invites ${added.map(guestLabel).join(', ')}`] : []),
    ...(removed.length > 0 ? [`uninvites ${removed.map(guestLabel).join(', ')}`] : []),
    ...change.choices.map((choice) =>
      choice.contacts.length > 0 ? `which ${choice.name}?` : `no contact “${choice.name}”`,
    ),
  ];
  const { inviteeChoices: _choices, ...rest } = draft;
  return {
    draft: {
      ...rest,
      extras: { ...extras, attendees },
      ...(choices.length > 0 ? { inviteeChoices: choices } : {}),
    },
    said,
  };
};

/**
 * A turn's place folded into a draft: the best one that resembles the
 * text becomes the location, pin and all (its text replaces what was
 * said, so a dictated "Cafe Zentral" reads Café Central), and the rest
 * stay on the draft to pick from; with none resembling it the text
 * stays as said and the hits wait as the choice. What it says: "3
 * places" beside the place taken, "which “Kaffee Sperl”?" for a choice
 * alone.
 */
const withPlace = (
  draft: Draft,
  change: PlaceChange | undefined,
): { readonly draft: Draft; readonly said: ReadonlyArray<string> } => {
  if (change === undefined || draft.item.kind !== 'event') {
    return { draft, said: [] };
  }
  const { placeChoice: _choice, ...rest } = draft;
  const { choice, taken } = settlePlace(change);
  const chosen = choice ? { placeChoice: choice } : {};
  if (taken) {
    return {
      draft: {
        ...rest,
        extras: { ...(draft.extras ?? BLANK_EXTRAS), geo: taken.geo },
        item: {
          kind: 'event',
          prefill: { ...draft.item.prefill, location: taken.geo.source },
        },
        ...chosen,
      },
      said: choice ? [`${String(choice.candidates.length)} places`] : [],
    };
  }
  return {
    draft: { ...rest, ...chosen },
    said: choice ? [`which “${choice.text}”?`] : [],
  };
};

/** "… · 3 free slots" when a turn found alternatives beside the draft's own. */
const withSlots = (summary: string, slots: ReadonlyArray<FreeSlot> | undefined): string =>
  slots && slots.length > 1 ? `${summary} · ${String(slots.length)} free slots` : summary;

export interface StartOptions {
  /** What the form already held: the first draft's. */
  readonly extras?: DraftExtras | undefined;
  /** Whom the phrase invited: the first draft's guests. */
  readonly guests?: GuestChange | undefined;
  readonly id?: (() => string) | undefined;
  /** What the phrase's place could mean: the first draft's. */
  readonly place?: PlaceChange | undefined;
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
  { extras, guests, id = nextDraftId, place, slots }: StartOptions = {},
): DraftThreadState => {
  let invited: ReadonlyArray<string> = [];
  const drafts = items.map((item, index) => {
    const draft: Draft = {
      ...(extras ? { extras } : {}),
      id: id(),
      item,
      ...(index === 0 && slots ? { slots } : {}),
    };
    if (index > 0) {
      return draft;
    }
    const placed = withPlace(draft, place);
    const first = withGuests(placed.draft, guests);
    invited = [...placed.said, ...first.said];
    return first.draft;
  });
  const summary =
    drafts.length === 1 && drafts[0]
      ? [
          withSlots(
            `${drafts[0].item.prefill.title || 'Untitled'} · ${describeDraftItem(drafts[0].item)}`,
            slots,
          ),
          ...invited,
        ].join(' · ')
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
  // What the turn did to the focused draft's place and guests, in words.
  let invited: ReadonlyArray<string> = [];
  const focused = state.drafts[state.focused];
  // The focused draft as the turn leaves it: a place taken changed its location too.
  let focusedAfter: Draft | undefined;
  const drafts = state.drafts.map((draft) => {
    const change = changed.get(draft.id);
    if (change === undefined) {
      return draft;
    }
    const placed = withPlace(
      {
        ...withoutSlots(draft),
        ...(change.extras ? { extras: change.extras } : {}),
        item: change.item,
        ...(change.slots ? { slots: change.slots } : {}),
      },
      change.place,
    );
    const next = withGuests(placed.draft, change.guests);
    if (draft.id === focused?.id) {
      invited = [...placed.said, ...next.said];
      focusedAfter = next.draft;
    }
    return next.draft;
  });
  const focusedChange = focused ? changed.get(focused.id) : undefined;
  const fieldsSaid =
    focused && focusedAfter ? summarizeChange(focused.item, focusedAfter.item) : '';
  const said =
    invited.length === 0
      ? fieldsSaid
      : [
          ...(fieldsSaid === 'no change' ? [] : [fieldsSaid]),
          ...invited.map((part) => `→ ${part}`),
        ].join(' · ');
  const summary =
    focused && focusedChange
      ? withSlots(
          changes.length > 1 ? `${said} (${String(changes.length)} drafts)` : said,
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
  // A slot is one day: a span the draft had ends with it.
  const { assumedTime: _assumed, endDate: _endDate, ...prefill } = item.prefill;
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
  lastDayOf(item) === undefined &&
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

/**
 * A choice settled by hand — a contact picked (the form took the guest)
 * or the name let go. Not a turn, and the form keeps what it holds.
 */
export const dropInviteeChoice = (
  state: DraftThreadState,
  index: number,
  name: string,
): DraftThreadState => {
  const draft = state.drafts[index];
  if (draft?.inviteeChoices === undefined) {
    return state;
  }
  const { inviteeChoices, ...rest } = draft;
  const left = inviteeChoices.filter((choice) => choice.name !== name);
  return {
    ...state,
    drafts: state.drafts.map((each, at) =>
      at === index ? { ...rest, ...(left.length > 0 ? { inviteeChoices: left } : {}) } : each,
    ),
  };
};

/** A place choice settled by hand — a candidate picked (the form took it) or the text kept. Not a turn. */
export const dropPlaceChoice = (state: DraftThreadState, index: number): DraftThreadState => {
  const draft = state.drafts[index];
  if (draft?.placeChoice === undefined) {
    return state;
  }
  const { placeChoice: _choice, ...rest } = draft;
  return { ...state, drafts: state.drafts.map((each, at) => (at === index ? rest : each)) };
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
/** How long a turn waits for a place's candidates at most; past it the text stays as said. */
const PLACE_LOOKUP_TIMEOUT = '5 seconds';

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

  /** Whom a turn invited or took off, as guests: each invited name looked up in the contacts. */
  const guestsOf = async (
    invite: ReadonlyArray<string> | undefined,
    uninvite: ReadonlyArray<string> | undefined,
  ): Promise<GuestChange | undefined> => {
    if ((invite ?? []).length === 0 && (uninvite ?? []).length === 0) {
      return undefined;
    }
    const found = await resolveInvitees(invite ?? [], (name) =>
      Effect.runPromise(backend.contactsNamed({ name })),
    );
    return { ...found, invited: invite ?? [], remove: uninvite ?? [] };
  };

  /**
   * What a turn's location text could mean: its candidates, past places
   * first (`placeCandidates`). None for no text; a failed or overlong
   * lookup is none found — the text stays as said, and the draft's
   * title and times never wait on a search (the handler bounds MapKit
   * itself; this bounds the call as a whole).
   */
  const placesOf = async (location: string | undefined): Promise<PlaceChange | undefined> => {
    if (location === undefined || location.trim() === '') {
      return undefined;
    }
    const candidates = await Effect.runPromise(
      backend.placeCandidates({ location }).pipe(
        Effect.timeout(PLACE_LOOKUP_TIMEOUT),
        Effect.orElseSucceed((): ReadonlyArray<PlaceCandidate> => []),
      ),
    );
    return { candidates, text: location };
  };

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
                  // A to-do's words about people are its title's.
                  guests: draft.item.kind === 'event',
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
      // Guests for the events among the drafts: a to-do has none.
      const changes = await Promise.all(
        results.flatMap(({ draft, result }) =>
          result?.kind === 'parsed'
            ? [
                (async (): Promise<DraftChange> => {
                  const isEvent = draft.item.kind === 'event';
                  // A place the turn set anew is looked up; one it left alone is not.
                  const before = isEvent ? draft.item.prefill.location : undefined;
                  const [guests, placeFound] = await Promise.all([
                    isEvent ? guestsOf(result.invite, result.uninvite) : undefined,
                    isEvent && result.prefill.location !== before
                      ? placesOf(result.prefill.location)
                      : undefined,
                  ]);
                  return {
                    ...(guests ? { guests } : {}),
                    id: draft.id,
                    item: convertQuickAddItem(
                      { kind: 'event', prefill: result.prefill },
                      draft.item.kind,
                    ),
                    ...(placeFound ? { place: placeFound } : {}),
                  };
                })(),
              ]
            : [],
        ),
      );
      if (mine !== request.current) {
        return undefined;
      }
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
    // The draft's whole length: an overnight one ends on the next day.
    const length =
      target?.item.kind === 'event' && !target.item.prefill.isAllDay
        ? draftMinutes(target.item.prefill, timeZone)
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
    const [guests, placeFound] =
      result.kind === 'parsed'
        ? await Promise.all([guestsOf(result.invite, undefined), placesOf(result.prefill.location)])
        : [undefined, undefined];
    if (mine !== request.current) {
      return undefined;
    }
    start(
      [
        result.kind === 'task'
          ? { kind: 'task', prefill: result.prefill }
          : { kind: 'event', prefill: result.prefill },
      ],
      text,
      { extras: firstDraftExtras(read?.().extras), guests, place: placeFound },
    );
    return undefined;
  };

  return {
    busy,
    clear: () => {
      request.current += 1;
      setState(EMPTY_THREAD);
    },
    /** A choice settled by hand: a contact picked (the form took the guest) or the name let go. */
    dropChoice: (index: number, name: string) =>
      setState((latest) => dropInviteeChoice(latest, index, name)),
    /** A place choice settled by hand: a candidate picked (the form took it) or the text kept. */
    dropPlace: (index: number) => setState((latest) => dropPlaceChoice(latest, index)),
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
