import {
  isFinderPhrase,
  type LanguageModel,
  NO_SLOT_FITS,
  type NotesChange,
  type PhraseReader,
  proposeSlots,
  type QuickAddPrefill,
  readExtras,
  type ReminderChange,
  type TurnDraft,
} from '@calendar/ai';
import {
  type AttendeeInput,
  type BackendClient,
  type EventRecord,
  type EventReminders,
  type FreeSlot,
  type GeoLocation,
  draftMinutes,
  normalizeLocationKey,
  type PlaceCandidate,
  Temporal,
} from '@calendar/core';
import { Effect } from 'effect';
import { useRef, useState } from 'react';
import {
  changedDraftFields,
  describeDraftItem,
  draftChanges,
  lastDayOf,
  type StepField,
  summarizeChange,
} from './draftChanges.ts';
import {
  alertMinutesOf,
  applyAlarmChange,
  applyNotesChange,
  applyReminderChange,
  describeAlarmChange,
  describeNotesChange,
  describeReminderChange,
} from './draftExtras.ts';
import {
  applyGuestChange,
  type GuestChange,
  guestLabel,
  type InviteeChoice,
  resolveInvitees,
} from './draftInvitees.ts';
import { type PlaceChange, type PlaceChoice, settlePlace } from './draftPlaces.ts';
import type { EventEditorPrefill } from './editorModel.ts';
import { convertQuickAddItem, type QuickAddItem } from './quickAddItem.ts';
import { recurrenceKey, seedRepeatFields } from './repeatState.ts';
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
  /** The location text kept as said: no place for it, none looked up (`keepLocationText`). */
  readonly locationAsSaid?: string | undefined;
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
  /** What the words did to the notes: applied to the draft's as they are when it lands. */
  readonly notes?: NotesChange | undefined;
  /** What the turn's location text could mean: a place taken, a choice left, or nothing. */
  readonly place?: PlaceChange | undefined;
  /** What the words did to the notifications: applied to the draft's as they are when it lands. */
  readonly reminders?: ReminderChange | undefined;
  /** The words gave the day, even where it is the day the draft held (a refinement's `saidDay`). */
  readonly saidDay?: boolean | undefined;
  readonly slots?: ReadonlyArray<FreeSlot> | undefined;
}

/** A phrase said or typed to the thread: one step of its history. */
export interface PhraseStep {
  /**
   * The drafts the turn made or changed, by id: whose words these are
   * (`turnsOf`). A turn that changed nothing is nobody's.
   */
  readonly drafts: ReadonlyArray<string>;
  readonly id: string;
  readonly kind: 'phrase';
  /** What the turn did to the drafts, in words — the thread's visible history. */
  readonly summary: string;
  readonly utterance: string;
}

/**
 * An edit made by hand in the form: the fields it changed on one draft.
 * Further edits to the same fields join the step (a title typed letter by
 * letter is one step); an edit to another field starts the next.
 */
export interface EditStep {
  readonly drafts: ReadonlyArray<string>;
  readonly fields: ReadonlyArray<StepField>;
  readonly id: string;
  readonly kind: 'edit';
}

/** What a pick settles: a contact for a name, a place for a text, a free slot. */
export type PickKind = 'guest' | 'place' | 'slot';

/** A choice the thread offered, taken by hand: a contact, a place or a free slot. */
export interface PickStep {
  readonly drafts: ReadonlyArray<string>;
  readonly id: string;
  readonly kind: 'pick';
  readonly pick: PickKind;
}

/**
 * One step of a thread, oldest first in `steps`: what happened to the
 * drafts between two of the states the thread can go back to — a phrase,
 * an edit by hand, a choice picked.
 */
export type DraftStep = EditStep | PhraseStep | PickStep;

/**
 * How the form came to hold what a fold reads from it: an edit, or a pick
 * among what the thread offered — a contact picked for a `name` settles
 * that open choice in the same step, so going back over it reopens it.
 */
export type HandStep =
  | { readonly kind: 'edit' }
  | { readonly kind: 'pick'; readonly name?: string | undefined; readonly pick: PickKind };

/** The drafts at one moment of the thread, and the one the form shows. */
export interface Snapshot {
  readonly drafts: ReadonlyArray<Draft>;
  readonly focused: number;
}

/** A step the thread stepped back over, with the drafts as it left them: what going forward restores. */
export interface StepAhead {
  readonly after: Snapshot;
  readonly step: DraftStep;
}

export interface DraftThreadState extends Snapshot {
  /**
   * The steps stepped back over, nearest first. Empty unless an older step
   * is shown (`stepTo`): the thread is then a preview until that step is
   * kept (`keepShown`, which lets these go) or the newest is shown again.
   */
  readonly ahead: ReadonlyArray<StepAhead>;
  /** The drafts as they were before each step, oldest first: what going back restores. */
  readonly history: ReadonlyArray<Snapshot>;
  /** What happened, oldest first: one entry per `history` snapshot. */
  readonly steps: ReadonlyArray<DraftStep>;
  /**
   * Moves on every change the form must take over (a turn, an undo, a
   * focus, a removal) and stays on the form's own edits (`foldForm`),
   * so a panel re-applies the focused draft exactly when it should.
   */
  readonly version: number;
}

export const EMPTY_THREAD: DraftThreadState = {
  ahead: [],
  drafts: [],
  focused: 0,
  history: [],
  steps: [],
  version: 0,
};

/**
 * A saved item as the first state of its own thread: one draft, read from
 * the form the item opened in, and no step yet. A phrase then changes it
 * as it changes any draft, an edit by hand is a step from the start, and
 * the state before the first step is the item as saved, never nothing.
 */
export const openThread = (
  base: FormSnapshot,
  id: () => string = nextDraftId,
): DraftThreadState => ({
  ...EMPTY_THREAD,
  drafts: [{ ...(base.extras ? { extras: base.extras } : {}), id: id(), item: base.item }],
});

/** A turn's words name someone to invite or to take off. */
const changesGuests = (change: GuestChange | undefined): boolean =>
  change !== undefined && change.invited.length + change.remove.length > 0;

/** The steps that are phrases, oldest first: what was said to the thread. */
export const phraseSteps = (state: DraftThreadState): ReadonlyArray<PhraseStep> =>
  state.steps.filter((step) => step.kind === 'phrase');

let counter = 0;
/** A fresh id for a draft or a turn; injectable so tests read stable ids. */
export const nextDraftId = (): string => {
  counter += 1;
  return `draft-${counter}`;
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
        // A place taken anew: a text kept as said before is said no more.
        extras: { ...(draft.extras ?? BLANK_EXTRAS), geo: taken.geo, locationAsSaid: undefined },
        item: {
          kind: 'event',
          prefill: { ...draft.item.prefill, location: taken.geo.source },
        },
        ...chosen,
      },
      said:
        choice && choice.candidates.length > 1
          ? [`${String(choice.candidates.length)} places`]
          : [],
    };
  }
  return {
    draft: { ...rest, ...chosen },
    said: choice ? [`which “${choice.text}”?`] : [],
  };
};

/**
 * A turn's note folded into a draft: on the notes an event's form holds
 * (`description`), or a to-do's own (`taskNotes`), blank ones for a
 * draft the form never held. What it says: "adds a note".
 */
const withNotes = (
  draft: Draft,
  change: NotesChange | undefined,
): { readonly draft: Draft; readonly said: ReadonlyArray<string> } => {
  if (change === undefined) {
    return { draft, said: [] };
  }
  const extras = draft.extras ?? BLANK_EXTRAS;
  const next: DraftExtras =
    draft.item.kind === 'task'
      ? { ...extras, taskNotes: applyNotesChange(extras.taskNotes ?? '', change) }
      : { ...extras, description: applyNotesChange(extras.description, change) };
  return { draft: { ...draft, extras: next }, said: [describeNotesChange(change)] };
};

/**
 * A turn's alerts folded into a to-do draft: its Reminders alarms
 * (`applyAlarmChange`), kept with its other Reminders-only fields, which
 * only a Reminders list writes, as it does the due time. What it says:
 * "alerts 10 minutes before".
 */
const withAlarms = (
  draft: Draft,
  change: ReminderChange,
): { readonly draft: Draft; readonly said: ReadonlyArray<string> } => {
  const extras = draft.extras ?? BLANK_EXTRAS;
  const fields = extras.reminder ?? {
    alarms: [],
    repeat: seedRepeatFields(undefined),
    url: '',
  };
  const applied = applyAlarmChange(fields.alarms, change);
  const said = describeAlarmChange(applied);
  if (applied.alarms === fields.alarms) {
    return { draft, said };
  }
  return {
    draft: { ...draft, extras: { ...extras, reminder: { ...fields, alarms: applied.alarms } } },
    said,
  };
};

/**
 * A turn's notifications folded into an event draft: popups at the
 * minutes said, on the draft's own or in place of them
 * (`applyReminderChange`). What it says: "notifies 30 minutes before".
 * A to-do's are its alerts (`withAlarms`).
 */
const withReminders = (
  draft: Draft,
  change: ReminderChange | undefined,
): { readonly draft: Draft; readonly said: ReadonlyArray<string> } => {
  if (change === undefined) {
    return { draft, said: [] };
  }
  if (draft.item.kind === 'task') {
    return withAlarms(draft, change);
  }
  const extras = draft.extras ?? BLANK_EXTRAS;
  const applied = applyReminderChange(extras.reminders, change);
  const said = describeReminderChange(change, applied, draft.item.prefill.isAllDay);
  if (applied.reminders === extras.reminders) {
    return { draft, said };
  }
  return { draft: { ...draft, extras: { ...extras, reminders: applied.reminders } }, said };
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
  /** The note the phrase added: the first draft's, after what the form held. */
  readonly notes?: NotesChange | undefined;
  /** What the phrase's place could mean: the first draft's. */
  readonly place?: PlaceChange | undefined;
  /** The notifications the phrase asked for: the first draft's. */
  readonly reminders?: ReminderChange | undefined;
  /** A finder phrase's slots: the first draft's (it sits in the best one). */
  readonly slots?: ReadonlyArray<FreeSlot> | undefined;
}

/**
 * The first turn: the phrase (or the paste) and every draft it made. What
 * the form already held (guests or notes typed before the phrase) goes
 * with the draft, the phrase's own note and notifications on top — a
 * phrase makes one draft, so the extras are its, as are the slots a
 * finder phrase found.
 */
export const startThread = (
  items: ReadonlyArray<QuickAddItem>,
  utterance: string,
  { extras, guests, id = nextDraftId, notes, place, reminders, slots }: StartOptions = {},
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
    const noted = withNotes(first.draft, notes);
    const reminded = withReminders(noted.draft, reminders);
    invited = [...placed.said, ...first.said, ...noted.said, ...reminded.said];
    return reminded.draft;
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
    ahead: [],
    drafts,
    focused: 0,
    history: [{ drafts: [], focused: 0 }],
    steps: [
      { drafts: drafts.map((draft) => draft.id), id: id(), kind: 'phrase', summary, utterance },
    ],
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
 * The words said to one draft, oldest first: the turns that made it or
 * changed its item. A bare turn leans on them ("it's in Graz" takes the
 * place of an earlier "it's in Vienna"), and what was said to another
 * draft, or changed nothing, is not this one's.
 */
export const turnsOf = (state: DraftThreadState, draftId: string): ReadonlyArray<string> =>
  phraseSteps(state).flatMap((turn) => (turn.drafts.includes(draftId) ? [turn.utterance] : []));

/** The draft without the slots a turn found for it. */
const withoutSlots = ({ slots: _slots, ...draft }: Draft): Draft => draft;

/**
 * A to-do the form held undated, as a turn that gave it a day or a time
 * leaves it: dated — the day is the words' now, no placeholder the form
 * may clear again (and undated once more with Undo). The day counts as
 * given when it is another one, and when the words said it (`saidDay`):
 * the placeholder is today, and "today" leaves it as it reads. A turn
 * about neither leaves the state alone.
 */
const datedBy = (draft: Draft, change: DraftChange): Pick<Draft, 'extras'> | undefined => {
  const before = draft.item;
  const after = change.item;
  return draft.extras?.undated &&
    before.kind === 'task' &&
    after.kind === 'task' &&
    (change.saidDay === true ||
      before.prefill.date !== after.prefill.date ||
      before.prefill.time !== after.prefill.time)
    ? { extras: { ...draft.extras, undated: false } }
    : undefined;
};

/**
 * A turn's results folded in: the changed drafts replace their old
 * selves, the rest stay, and the state before goes to the history. A
 * changed draft keeps slots only when the turn brings its own — the old
 * ones were found for other words. The summary lists what changed on
 * the focused draft, or how many changed. A change for a draft that is
 * gone (removed or saved while the model answered) is nobody's; with
 * none left the turn is no step.
 */
export const refineThread = (
  state: DraftThreadState,
  utterance: string,
  all: ReadonlyArray<DraftChange>,
  id: () => string = nextDraftId,
): DraftThreadState => {
  const changes = all.filter((change) => state.drafts.some((draft) => draft.id === change.id));
  if (changes.length === 0) {
    return state;
  }
  const changed = new Map(changes.map((change) => [change.id, change]));
  // What the turn did to the focused draft's place, guests, notes and notifications, in words.
  let invited: ReadonlyArray<string> = [];
  const focused = state.drafts[state.focused];
  // The focused draft as the turn leaves it: a place taken changed its location too.
  let focusedAfter: Draft | undefined;
  const dated = new Set<string>();
  const drafts = state.drafts.map((draft) => {
    const change = changed.get(draft.id);
    if (change === undefined) {
      return draft;
    }
    const placed = withPlace(
      {
        ...withoutSlots(draft),
        ...(change.extras ? { extras: change.extras } : datedBy(draft, change)),
        item: change.item,
        ...(change.slots ? { slots: change.slots } : {}),
      },
      change.place,
    );
    const guested = withGuests(placed.draft, change.guests);
    const noted = withNotes(guested.draft, change.notes);
    const next = withReminders(noted.draft, change.reminders);
    // A to-do dated on the day it already read ("today" said of one shown
    // on today): no field of the item moved, and yet it is due now.
    const due =
      draft.extras?.undated === true &&
      next.draft.extras?.undated !== true &&
      draft.item.prefill.date === next.draft.item.prefill.date;
    if (due) {
      dated.add(draft.id);
    }
    if (draft.id === focused?.id) {
      invited = [
        ...(due ? [`due ${describeDraftItem(next.draft.item)}`] : []),
        ...placed.said,
        ...guested.said,
        ...noted.said,
        ...next.said,
      ];
      focusedAfter = next.draft;
    }
    return next.draft;
  });
  // The drafts whose item the turn left another, or dated: the ones its words are said to.
  const moved = drafts.flatMap((draft, index) =>
    dated.has(draft.id) || changedDraftFields(state.drafts[index]!.item, draft.item).length > 0
      ? [draft.id]
      : [],
  );
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
    // A turn from an older step leaves what came after it behind.
    ahead: [],
    drafts,
    focused: state.focused,
    history: [...state.history, { drafts: state.drafts, focused: state.focused }],
    steps: [...state.steps, { drafts: moved, id: id(), kind: 'phrase', summary, utterance }],
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

/** What the form holds of the draft it shows at one moment: its item and extras. */
export interface FormSnapshot {
  readonly extras?: DraftExtras | undefined;
  readonly item: QuickAddItem;
  /**
   * The draft the form shows, by id, where the reader knows it. It is the
   * focused one but for a moment after the focus moved, while the form is
   * still taking the newly focused draft in: what it reads then is the
   * draft that left.
   */
  readonly shown?: string | undefined;
}

/**
 * A form reading folded into the draft the form shows (`shown`; the
 * focused one where it names none). One that is gone takes nothing — and
 * the reading never lands on another draft.
 */
const foldShown = (state: DraftThreadState, form: FormSnapshot): DraftThreadState =>
  updateDraft(
    state,
    form.shown === undefined
      ? state.focused
      : state.drafts.findIndex((draft) => draft.id === form.shown),
    form.item,
    form.extras,
  );

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
  const base = foldShown(state, fresh);
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
    notes,
    reminders,
    slots,
    targetId,
    title,
    utterance,
  }: {
    readonly fresh?: FormSnapshot | undefined;
    /** A note the finder phrase added beside the slot. */
    readonly notes?: NotesChange | undefined;
    /** Notifications the finder phrase asked for beside the slot. */
    readonly reminders?: ReminderChange | undefined;
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
  const based = fresh === undefined ? state : foldShown(state, fresh);
  const draft = based.drafts[index]!;
  return refineThread(based, utterance, [
    {
      ...(draft.extras?.undated ? { extras: { ...draft.extras, undated: false } } : {}),
      id: draft.id,
      item: itemAtSlot(draft.item, best, title),
      ...(notes ? { notes } : {}),
      ...(reminders ? { reminders } : {}),
      slots,
    },
  ]);
};

/**
 * The last turn taken back, with whatever was done by hand since it
 * landed: the drafts as that phrase found them. Taking back the first
 * one leaves no drafts.
 */
export const undoTurn = (state: DraftThreadState): DraftThreadState => {
  const at = state.steps.findLastIndex((step) => step.kind === 'phrase');
  const previous = state.history[at];
  if (previous === undefined) {
    return state;
  }
  return {
    ahead: [],
    drafts: previous.drafts,
    focused: Math.min(previous.focused, Math.max(previous.drafts.length - 1, 0)),
    history: state.history.slice(0, at),
    steps: state.steps.slice(0, at),
    version: state.version + 1,
  };
};

/** One step as the thread's history lists it: the drafts around it, and whether it was stepped back over. */
export interface StepLine {
  readonly after: Snapshot;
  readonly before: Snapshot;
  /** Stepped back over: it is still there to go forward to until the shown step is kept. */
  readonly dimmed: boolean;
  /** How many steps are applied once this one is: what `stepTo` takes to show it. */
  readonly position: number;
  readonly step: DraftStep;
}

/**
 * Every step of the thread, oldest first, with the drafts before and after
 * it — the ones stepped back over included, dimmed. Before and after are
 * read off the history, never stored twice: a step's after is the next
 * one's before.
 */
export const threadLine = (state: DraftThreadState): ReadonlyArray<StepLine> => {
  const moments: ReadonlyArray<Snapshot> = [
    ...state.history,
    { drafts: state.drafts, focused: state.focused },
    ...state.ahead.map((gone) => gone.after),
  ];
  return [...state.steps, ...state.ahead.map((gone) => gone.step)].map((step, at) => ({
    after: moments[at + 1]!,
    before: moments[at]!,
    dimmed: at >= state.steps.length,
    position: at + 1,
    step,
  }));
};

/**
 * The thread as it stood after `position` steps (0: before the first; the
 * count of all of them: the newest), shown without letting anything go:
 * the steps after it wait in `ahead`. The form must take the drafts over,
 * so the version moves. A position that is already shown, or none there
 * is, leaves the thread as it is.
 */
export const stepTo = (state: DraftThreadState, position: number): DraftThreadState => {
  const line = threadLine(state);
  if (position === state.steps.length || position < 0 || position > line.length) {
    return state;
  }
  const shown = position === 0 ? line[0]!.before : line[position - 1]!.after;
  return {
    ahead: line.slice(position).map(({ after, step }) => ({ after, step })),
    drafts: shown.drafts,
    focused: Math.min(shown.focused, Math.max(shown.drafts.length - 1, 0)),
    history: line.slice(0, position).map(({ before }) => before),
    steps: line.slice(0, position).map(({ step }) => step),
    version: state.version + 1,
  };
};

/** "Use this": the step shown is the newest from here on, and what came after it is let go. */
export const keepShown = (state: DraftThreadState): DraftThreadState =>
  state.ahead.length === 0 ? state : { ...state, ahead: [] };

export const focusDraft = (state: DraftThreadState, index: number): DraftThreadState =>
  index >= 0 && index < state.drafts.length && index !== state.focused
    ? { ...state, focused: index, version: state.version + 1 }
    : state;

/**
 * What the form holds of a draft — its fields and what the form holds
 * beyond them — kept without a step: the form's own reading of a draft it
 * just took in (so an edit made by hand later is told from it exactly),
 * and what a draft leaves the form with when another takes it. An edit
 * made by hand goes through `foldForm`, which makes a step of it.
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

/** The draft without the open choice for `name`, if it has one. */
const withoutChoice = (draft: Draft, name: string | undefined): Draft => {
  if (name === undefined || draft.inviteeChoices === undefined) {
    return draft;
  }
  const { inviteeChoices, ...rest } = draft;
  const left = inviteeChoices.filter((choice) => choice.name !== name);
  return left.length > 0 ? { ...rest, inviteeChoices: left } : rest;
};

/**
 * An edit made by hand, read from the form into the draft it shows. What
 * the form holds becomes the focused draft's; when that changes a field,
 * it is a step one can go back over — the drafts before go to the
 * history — and the version stays, since the form already shows it. An edit joins the newest step when that is an edit of the
 * same draft whose fields cover it, so typing is one step and not one
 * per letter; a step whose edits end where they began is no step. A
 * pick is always its own step, and settles the choice it answered.
 * Nothing to fold into (no draft yet, or an older step on show) leaves
 * the thread as it is.
 */
export const foldForm = (
  state: DraftThreadState,
  form: FormSnapshot,
  how: HandStep = { kind: 'edit' },
  id: () => string = nextDraftId,
): DraftThreadState => {
  const draft = state.drafts[state.focused];
  // An older step on show is locked: there is nothing by hand to read.
  // Nor is a reading of another draft than the focused one this one's.
  if (
    draft === undefined ||
    state.ahead.length > 0 ||
    (form.shown !== undefined && form.shown !== draft.id)
  ) {
    return state;
  }
  const next = withoutChoice(
    { ...draft, ...(form.extras ? { extras: form.extras } : {}), item: form.item },
    how.kind === 'pick' ? how.name : undefined,
  );
  const drafts = state.drafts.map((each, at) => (at === state.focused ? next : each));
  const fields = draftChanges(draft, next).map((change) => change.field);
  if (fields.length === 0) {
    return { ...state, drafts };
  }
  const newest = state.steps.at(-1);
  const joins =
    how.kind === 'edit' &&
    newest?.kind === 'edit' &&
    newest.drafts[0] === draft.id &&
    fields.every((field) => newest.fields.includes(field));
  if (!joins) {
    const step: DraftStep =
      how.kind === 'pick'
        ? { drafts: [draft.id], id: id(), kind: 'pick', pick: how.pick }
        : { drafts: [draft.id], fields, id: id(), kind: 'edit' };
    return {
      ...state,
      drafts,
      history: [...state.history, { drafts: state.drafts, focused: state.focused }],
      steps: [...state.steps, step],
    };
  }
  // The step as it stands now, against the drafts it started from.
  const began = state.history.at(-1)?.drafts.find((each) => each.id === draft.id);
  const net = draftChanges(began, next).map((change) => change.field);
  return net.length === 0
    ? { ...state, drafts, history: state.history.slice(0, -1), steps: state.steps.slice(0, -1) }
    : { ...state, drafts, steps: [...state.steps.slice(0, -1), { ...newest, fields: net }] };
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

/** Some draft of the snapshot still offers free slots. */
const offered = (snapshot: Snapshot): boolean =>
  snapshot.drafts.some((draft) => draft.slots !== undefined);

/**
 * Every free slot a finder phrase found, let go of — on the drafts, and
 * on the drafts of the steps kept to go back or forward to. They were
 * searched under what no longer holds (a saved series' scope changed:
 * "All events" leaves its own occurrences out of the way, "This event"
 * does not), so none of them may be offered again. Not a step.
 */
export const dropSlots = (state: DraftThreadState): DraftThreadState => {
  if (
    !offered(state) &&
    !state.history.some(offered) &&
    !state.ahead.some((step) => offered(step.after))
  ) {
    return state;
  }
  const bare = (snapshot: Snapshot): Snapshot => ({
    drafts: snapshot.drafts.map(withoutSlots),
    focused: snapshot.focused,
  });
  return {
    ...state,
    ahead: state.ahead.map((step) => ({ ...step, after: bare(step.after) })),
    drafts: state.drafts.map(withoutSlots),
    history: state.history.map(bare),
  };
};

/**
 * A saved series' rule that became known after its thread opened (its
 * master was read late, or the rule changed elsewhere): the form seeds
 * itself with it again, and every state of the item that still holds the
 * rule the thread opened with takes it too — it is the item's own, no
 * step. A state a step gave another rule keeps that one. Left out, "As
 * saved" would be the series without its rule, and keeping that state
 * would save it so.
 */
export const reseedRule = (
  state: DraftThreadState,
  recurrence: EventEditorPrefill['recurrence'],
): DraftThreadState => {
  const base = (state.history[0] ?? state).drafts[0];
  if (base === undefined || base.item.kind !== 'event') {
    return state;
  }
  const opened = recurrenceKey(base.item.prefill.recurrence);
  if (opened === recurrenceKey(recurrence)) {
    return state;
  }
  const seeded = (draft: Draft): Draft => {
    if (
      draft.id !== base.id ||
      draft.item.kind !== 'event' ||
      recurrenceKey(draft.item.prefill.recurrence) !== opened
    ) {
      return draft;
    }
    const { recurrence: _opened, ...rest } = draft.item.prefill;
    return {
      ...draft,
      item: { kind: 'event', prefill: recurrence ? { ...rest, recurrence } : rest },
    };
  };
  const through = (snapshot: Snapshot): Snapshot => ({
    drafts: snapshot.drafts.map(seeded),
    focused: snapshot.focused,
  });
  return {
    ...state,
    ahead: state.ahead.map((step) => ({ ...step, after: through(step.after) })),
    drafts: state.drafts.map(seeded),
    history: state.history.map(through),
  };
};

/**
 * The rule a step gave a saved item, where it is another than the item
 * opened with — wrapped, since "no rule" is one a step can give too.
 * Undefined where no step changed it.
 */
export const stepRule = (
  state: DraftThreadState,
): { readonly recurrence: EventEditorPrefill['recurrence'] } | undefined => {
  const base = (state.history[0] ?? state).drafts[0];
  const now = state.drafts.find((draft) => draft.id === base?.id);
  if (base?.item.kind !== 'event' || now?.item.kind !== 'event') {
    return undefined;
  }
  return recurrenceKey(base.item.prefill.recurrence) === recurrenceKey(now.item.prefill.recurrence)
    ? undefined
    : { recurrence: now.item.prefill.recurrence };
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
 * twice — and with them the steps made by hand on them alone. The
 * version moves only when the form must change — the focused draft left,
 * or none is left — never for another draft going.
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
  // What was done by hand to a draft that left goes with it: there is no
  // step to go back over once its draft is written. A phrase stays, as
  // what was said.
  const kept = state.steps.map(
    (step) => step.kind === 'phrase' || !step.drafts.every((id) => gone.has(id)),
  );
  return {
    ...state,
    ...next,
    ahead: state.ahead
      .filter(({ step }) => step.kind === 'phrase' || !step.drafts.every((id) => gone.has(id)))
      .map(({ after, step }) => ({ after: without(after, gone), step })),
    history: state.history.filter((_, at) => kept[at]).map((snapshot) => without(snapshot, gone)),
    steps: state.steps.filter((_, at) => kept[at]),
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

/**
 * Why a turn cannot be taken, or undefined: what the item being changed
 * cannot hold (a stored event's limits — `turnRefusal`; a time or an
 * alert on a list that keeps none — `todoTimeRefusal`, `todoAlertRefusal`),
 * given the draft before the turn, its item after it, whether the turn
 * changes its guests (invites someone or takes someone off), and whether
 * it adds notifications (a to-do's alerts).
 */
export type Refuse = (
  draft: Draft,
  after: QuickAddItem,
  guests: boolean,
  alerts: boolean,
) => string | undefined;

/** What a phrase is said with. */
export interface PhraseOptions {
  /**
   * A first phrase may make the draft(s) (a new item). False for a saved
   * item, whose thread starts as that item: a phrase only ever changes it.
   */
  readonly canStart?: boolean | undefined;
  /** Rows a finder phrase does not count as busy: the event being moved itself. */
  readonly exclude?: ((event: EventRecord) => boolean) | undefined;
  /** Where an undated first phrase lands (the day being viewed). */
  readonly fallbackDate: string;
  readonly read?: ReadForm | undefined;
  readonly refuse?: Refuse | undefined;
}

/** A phrase said to a saved item before its thread has opened. */
const NOT_OPEN_YET = 'Still opening — try again in a moment.';

/** A finder phrase whose search was let go of: what it applies to changed under it. */
const SCOPE_MOVED = '“Apply to” changed while searching — send it again.';

/** A finder phrase on an all-day draft, or none: the length searched for. */
const DEFAULT_SLOT_MINUTES = 60;
/** How long a turn waits for a place's candidates at most; past it the text stays as said. */
const PLACE_LOOKUP_TIMEOUT = '5 seconds';
/** A turn that took the place away: nothing to choose from, the choice before it goes. */
const NO_PLACE: PlaceChange = { candidates: [], text: '' };

/**
 * The thread as a hook: the state above, what a phrase does (`phrase`:
 * the router, quick-add for a first phrase, a refinement for a later one,
 * slot proposals for one that asks for free time), and the stale-answer
 * guard. A turn that lands after the thread was cleared or another turn
 * began is dropped; a form snapshot of the focused draft (`read`) is
 * folded in first, so a turn starts from what the user sees and its
 * summary lists only what the words changed.
 */
/** The popup notifications a draft holds, in minutes before; none while it keeps the calendar's default. */
const popupMinutesOf = (
  reminders: EventReminders | undefined,
): ReadonlyArray<number> | undefined =>
  reminders === undefined || reminders.useDefault
    ? undefined
    : reminders.overrides
        .filter((override) => override.method === 'popup')
        .map((override) => override.minutes);

/**
 * A draft as a reader's turn sees it (`TurnDraft`): the item as the event
 * it would be, the addresses already invited, its notes and notifications
 * — the calendar's default ones (`defaults`) where an event keeps to them;
 * a to-do's notifications are its own alerts, and it has no default.
 */
export const turnDraftOf = (
  draft: Draft,
  prefill: QuickAddPrefill,
  defaults?: ReadonlyArray<number> | undefined,
): TurnDraft => {
  const task = draft.item.kind === 'task';
  const notes = task ? draft.extras?.taskNotes : draft.extras?.description;
  const reminders = task
    ? alertMinutesOf(draft.extras?.reminder?.alarms)
    : popupMinutesOf(draft.extras?.reminders);
  return {
    ...(!task && reminders === undefined && defaults !== undefined
      ? { defaultReminders: defaults }
      : {}),
    guests: (draft.extras?.attendees ?? []).map((attendee) => attendee.email),
    kind: draft.item.kind,
    notes: notes?.trim() ? notes : undefined,
    prefill,
    reminders,
  };
};

export const useDraftThread = ({
  backend,
  defaultRemindersOf,
  model,
  reader,
  timeZone,
}: {
  /** The events a finder phrase searches between. */
  backend: BackendClient;
  /** The default notifications of the calendar a draft would go to (minutes before), where known. */
  defaultRemindersOf?: ((draft: Draft) => ReadonlyArray<number> | undefined) | undefined;
  /** The model a finder phrase is read with (find a time keeps Apple's, or a served one). */
  model: LanguageModel;
  /** How a phrase and a change are read: the Assistant's own model, through `tunedReader`. */
  reader: PhraseReader;
  timeZone: string;
}) => {
  const [state, setState] = useState<DraftThreadState>(EMPTY_THREAD);
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  // The request that is searching for free slots, and the one such search
  // a change of scope let go of (`dropSlots`).
  const searching = useRef<number | undefined>(undefined);
  const unscoped = useRef<number | undefined>(undefined);
  /**
   * An answer still on its way is dropped (it would land on drafts that
   * are no longer the ones it was asked about), and with it the wait: a
   * turn clears `busy` only while it is still the latest request.
   */
  const abandon = () => {
    request.current += 1;
    setBusy(false);
  };

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
  const refine = async (
    utterance: string,
    read?: ReadForm,
    refuse?: Refuse,
  ): Promise<string | undefined> => {
    // A draft focused meanwhile is not where the answer lands (`landRefinement`).
    const mine = ++request.current;
    const submitted = read?.();
    const current = submitted === undefined ? state : foldShown(state, submitted);
    const focusedId = current.drafts[current.focused]?.id;
    // "all" or "both" in a note ("bring both contracts") or about the
    // notifications ("remove all reminders") addresses no other draft.
    const targets = refineTargets(current, readExtras(utterance).rest);
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
              ? await reader.change({
                  draft: turnDraftOf(draft, asEvent.prefill, defaultRemindersOf?.(draft)),
                  referenceDate,
                  said: turnsOf(current, draft.id),
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
                  // A place the turn set anew is looked up; one it left alone
                  // (or only re-spelled) is not; one it took away clears the
                  // choice with it.
                  const before = isEvent ? draft.item.prefill.location : undefined;
                  const after = result.prefill.location;
                  const moved =
                    isEvent &&
                    normalizeLocationKey(after ?? '') !== normalizeLocationKey(before ?? '');
                  const [guests, placeFound] = await Promise.all([
                    isEvent ? guestsOf(result.invite, result.uninvite) : undefined,
                    moved ? placesOf(after).then((found) => found ?? NO_PLACE) : undefined,
                  ]);
                  return {
                    ...(guests ? { guests } : {}),
                    id: draft.id,
                    item: convertQuickAddItem(
                      { kind: 'event', prefill: result.prefill },
                      draft.item.kind,
                    ),
                    ...(result.notes ? { notes: result.notes } : {}),
                    ...(placeFound ? { place: placeFound } : {}),
                    ...(result.reminders ? { reminders: result.reminders } : {}),
                    ...(result.saidDay ? { saidDay: true } : {}),
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
      // What the item cannot hold is said, and nothing of the turn lands.
      const refused = changes
        .map((change) => {
          const draft = current.drafts.find((each) => each.id === change.id);
          return draft === undefined
            ? undefined
            : refuse?.(
                draft,
                change.item,
                changesGuests(change.guests),
                (change.reminders?.add.length ?? 0) > 0,
              );
        })
        .find((message) => message !== undefined);
      if (refused !== undefined) {
        return refused;
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
   * A note or notifications said with it (`readExtras`) go on the draft too.
   */
  const place = async (
    utterance: string,
    read: ReadForm | undefined,
    { notes, reminders, rest }: ReturnType<typeof readExtras>,
    { canStart, exclude, refuse }: Pick<PhraseOptions, 'canStart' | 'exclude' | 'refuse'>,
  ): Promise<string | undefined> => {
    const mine = ++request.current;
    const said = {
      ...(notes ? { notes } : {}),
      ...(reminders ? { reminders } : {}),
    };
    const submitted = read?.();
    const current = submitted === undefined ? state : foldShown(state, submitted);
    const target = current.drafts[current.focused];
    // The draft's whole length: an overnight one ends on the next day.
    const length =
      target?.item.kind === 'event' && !target.item.prefill.isAllDay
        ? draftMinutes(target.item.prefill, timeZone)
        : 0;
    setBusy(true);
    searching.current = mine;
    try {
      const result = await proposeSlots(model, backend, {
        ...(exclude ? { exclude } : {}),
        fallbackDurationMinutes: length > 0 ? length : DEFAULT_SLOT_MINUTES,
        phrase: rest,
        referenceDate: Temporal.Now.plainDateISO(timeZone).toString(),
        timeZone,
      });
      if (mine !== request.current) {
        // Let go of because what it applies to changed: said, and the
        // words stay in the field to send again. Anything else that
        // overtook it (a step shown, an Undo) was the user's next move.
        return unscoped.current === mine ? SCOPE_MOVED : undefined;
      }
      if (result.kind === 'rejected') {
        return result.reason;
      }
      const [best] = result.slots;
      if (best === undefined) {
        return NO_SLOT_FITS;
      }
      if (target === undefined) {
        if (canStart === false) {
          return NOT_OPEN_YET;
        }
        const extras = firstDraftExtras(read?.().extras);
        setState(
          startThread([slotItem(best, result.title)], utterance, {
            extras,
            ...said,
            slots: result.slots,
          }),
        );
        return undefined;
      }
      // The notifications said with it land on the draft too: a to-do's
      // alert counts, where its list keeps none.
      const refused = refuse?.(
        target,
        itemAtSlot(target.item, best, result.title),
        false,
        (reminders?.add.length ?? 0) > 0,
      );
      if (refused !== undefined) {
        return refused;
      }
      const fresh = read?.();
      setState((latest) =>
        landPlacement(latest, {
          fresh,
          ...said,
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
      if (searching.current === mine) {
        searching.current = undefined;
      }
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
    { canStart, exclude, fallbackDate, read, refuse }: PhraseOptions,
  ): Promise<string | undefined> => {
    // The finder's cue is read in the words about the event, not in a
    // note or a notification said with them.
    const extras = readExtras(text);
    if (isFinderPhrase(extras.rest)) {
      return place(text, read, extras, { canStart, exclude, refuse });
    }
    if (state.drafts.length > 0) {
      return refine(text, read, refuse);
    }
    // A saved item's thread has its draft from the start (`openThread`):
    // words that arrive before it has are not a new item's.
    if (canStart === false) {
      return NOT_OPEN_YET;
    }
    const mine = request.current;
    const result = await reader.first({
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
      {
        extras: firstDraftExtras(read?.().extras),
        guests,
        ...(result.notes ? { notes: result.notes } : {}),
        place: placeFound,
        ...(result.reminders ? { reminders: result.reminders } : {}),
      },
    );
    return undefined;
  };

  return {
    busy,
    clear: () => {
      abandon();
      setState(EMPTY_THREAD);
    },
    /** A choice settled by hand: a contact picked (the form took the guest) or the name let go. */
    dropChoice: (index: number, name: string) =>
      setState((latest) => dropInviteeChoice(latest, index, name)),
    /** A place choice settled by hand: a candidate picked (the form took it) or the text kept. */
    dropPlace: (index: number) => setState((latest) => dropPlaceChoice(latest, index)),
    /**
     * The free slots found so far no longer hold (`dropSlots`); a search
     * for them still out is dropped with them, and says so. A phrase
     * being read that searches for nothing lands as it would have.
     */
    dropSlots: () => {
      if (searching.current !== undefined) {
        unscoped.current = searching.current;
        abandon();
      }
      setState((latest) => dropSlots(latest));
    },
    focus: (index: number) => setState((latest) => focusDraft(latest, index)),
    /** A saved item's thread starts as that item (`openThread`); a thread under way stays. */
    open: (base: FormSnapshot) =>
      setState((latest) =>
        latest.drafts.length === 0 && latest.steps.length === 0 && latest.ahead.length === 0
          ? openThread(base)
          : latest,
      ),
    phrase,
    refine,
    remove: (index: number) => setState((latest) => removeDraft(latest, index)),
    /** A saved series' rule known only now, taken into every state that held the old one (`reseedRule`). */
    removeMany: (ids: ReadonlyArray<string>) => setState((latest) => removeDrafts(latest, ids)),
    reseedRule: (recurrence: EventEditorPrefill['recurrence']) =>
      setState((latest) => reseedRule(latest, recurrence)),
    start,
    state,
    undo: () => {
      abandon();
      setState((latest) => undoTurn(latest));
    },
    /** "Use this": the step shown stays, what came after it goes (`keepShown`). */
    keep: () => setState((latest) => keepShown(latest)),
    /**
     * Another step is shown (`stepTo`); an answer still on its way would
     * land on drafts that are no longer the shown ones, so it is dropped.
     */
    show: (position: number) => {
      abandon();
      setState((latest) => stepTo(latest, position));
    },
    /** One step back from the one shown, or forward again (`stepTo`). */
    stepBy: (by: -1 | 1) => {
      abandon();
      setState((latest) => stepTo(latest, latest.steps.length + by));
    },
    /**
     * The form read into the draft it shows after an edit by hand: a field
     * it changed is a step (`foldForm`).
     */
    record: (form: FormSnapshot, how?: HandStep) =>
      setState((latest) => foldForm(latest, form, how)),
    /** What the form holds of a draft, kept without a step (`updateDraft`). */
    update: (index: number, item: QuickAddItem, extras?: DraftExtras) =>
      setState((latest) => updateDraft(latest, index, item, extras)),
  };
};
