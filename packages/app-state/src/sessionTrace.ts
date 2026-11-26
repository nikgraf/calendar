import {
  type AssistantSession,
  type Heard,
  type QuickAddResult,
  SESSION_LOG_VERSION,
  type SessionAbout,
  type SessionCandidate,
  type SessionInvitee,
  type SessionOutcome,
  type SessionPick,
  type SessionPlace,
  type SessionRead,
  type SessionReading,
  type SessionSaved,
  type SessionTurn,
  type TunedExchange,
} from '@calendar/ai';
import { emailKey, nameWithAddress } from '@calendar/core';
import { draftChanges } from './draftChanges.ts';
import type { GuestChange } from './draftInvitees.ts';
import { pickedCandidate, type PlaceChange, settlePlace } from './draftPlaces.ts';
import type { Draft, DraftThreadState, FormSnapshot, HandStep } from './draftThread.ts';

/**
 * What a thread keeps of itself for the session log (`sessionLog.ts` in
 * `@calendar/ai`) while it runs, and the record it comes to when its
 * editor closes. Pure: `useDraftThread` holds a trace beside its state,
 * adds to it where a turn, a pick or a save happens, and hands the
 * finished record to the platform's store. Nothing here decides whether
 * sessions are kept; the hook asks the switch.
 */

/** A turn as the trace holds it: with the id of the step (or the answer) it made, to find it again. */
interface TracedTurn {
  readonly step?: string | undefined;
  readonly turn: SessionTurn;
}

/** A written item as the trace holds it: with the draft it was, to tell the drafts left over. */
interface TracedSaved {
  readonly draft?: string | undefined;
  readonly item: SessionSaved;
}

export interface SessionTrace {
  readonly origin: AssistantSession['origin'];
  readonly picks: ReadonlyArray<SessionPick>;
  readonly saved: ReadonlyArray<TracedSaved>;
  readonly turns: ReadonlyArray<TracedTurn>;
}

export const EMPTY_TRACE: SessionTrace = { origin: 'new', picks: [], saved: [], turns: [] };

/**
 * What a turn gathers while it runs: filled in by the hook's own steps
 * (the reads, the place and the guests it looked up, the thread before
 * and after it landed), read once the turn is over (`endTurn`).
 */
export interface TurnNotes {
  /** Let go of with a message (the scope moved under a search): no refusal of the model's. */
  dropped?: boolean | undefined;
  /** The model could not answer: the turn's message says so, and it is no refusal. */
  failed?: boolean | undefined;
  freeSlots?: number | undefined;
  invited?: ReadonlyArray<SessionInvitee> | undefined;
  /** The thread before the turn landed and as it left it; absent: it never landed. */
  landed?: { readonly after: DraftThreadState; readonly before: DraftThreadState } | undefined;
  place?: SessionPlace | undefined;
  readonly reads: Array<SessionRead>;
  route: SessionTurn['route'];
  uninvited?: ReadonlyArray<string> | undefined;
}

export const turnNotes = (): TurnNotes => ({ reads: [], route: 'first' });

/**
 * One question to the model, kept as it is asked: the reader tells the
 * prompt and the answer (`onExchange`), the caller the result (`done`,
 * which gives it back). Without notes (sessions are not kept) it keeps
 * nothing and asks the reader for nothing.
 */
export const openRead = (
  notes: TurnNotes | undefined,
): {
  readonly done: <Result extends QuickAddResult>(result: Result) => Result;
  readonly onExchange: ((exchange: TunedExchange) => void) | undefined;
} => {
  if (notes === undefined) {
    return { done: (result) => result, onExchange: undefined };
  }
  const at = notes.reads.length;
  notes.reads.push({});
  return {
    done: (result) => {
      notes.reads[at] = { ...notes.reads[at], result };
      return result;
    },
    onExchange: ({ answer, failed, prompt }) => {
      // A model that threw gave no answer: the turn failed, whatever it says.
      if (failed === true) {
        notes.failed = true;
      }
      notes.reads[at] = { ...notes.reads[at], ...(failed === true ? {} : { answer }), prompt };
    },
  };
};

const candidateOf = (candidate: PlaceChange['candidates'][number]): SessionCandidate => ({
  ...(candidate.address === undefined ? {} : { address: candidate.address }),
  ...(candidate.alternative === undefined ? {} : { alternative: candidate.alternative }),
  match: candidate.match,
  name: candidate.geo.source,
  source: candidate.source,
});

/**
 * A turn's place as the log keeps it: every candidate offered, and the
 * one the thread took unasked (`settlePlace`). Nothing for a turn that
 * took the place away.
 */
export const sessionPlace = (change: PlaceChange | undefined): SessionPlace | undefined => {
  if (change === undefined || change.text.trim() === '') {
    return undefined;
  }
  const { taken } = settlePlace(change);
  const at = taken === undefined ? -1 : change.candidates.indexOf(taken);
  return {
    candidates: change.candidates.map(candidateOf),
    ...(at === -1 ? {} : { taken: at }),
    text: change.text,
  };
};

/**
 * The names a turn invited, each with what the contacts gave: the one
 * person it named, or the people it could be. `resolveInvitees` adds a
 * guest per name that named one, in the order the names were said.
 */
export const sessionInvitees = (change: GuestChange | undefined): ReadonlyArray<SessionInvitee> => {
  if (change === undefined) {
    return [];
  }
  let next = 0;
  return change.invited.map((name) => {
    const choice = change.choices.find((each) => each.name === name);
    if (choice !== undefined) {
      return { choices: choice.contacts.map(nameWithAddress), name };
    }
    const taken = change.add[next];
    next += 1;
    return taken === undefined ? { name } : { name, taken: nameWithAddress(taken) };
  });
};

/**
 * What a turn did, read off the thread before and after it landed: a new
 * phrase step (its summary), a new answer to words that changed nothing,
 * or neither (the drafts it was said to were gone).
 */
export const turnOutcome = (
  before: DraftThreadState,
  after: DraftThreadState,
): { readonly outcome: SessionOutcome; readonly step?: string } => {
  const step = after.steps.at(-1);
  if (step?.kind === 'phrase' && !before.steps.some((each) => each.id === step.id)) {
    return { outcome: { kind: 'changed', summary: step.summary }, step: step.id };
  }
  const quiet = after.noChange.at(-1);
  if (quiet !== undefined && !before.noChange.some((each) => each.id === quiet.id)) {
    return {
      outcome: { kind: 'no-change', ...(quiet.note === undefined ? {} : { note: quiet.note }) },
      step: quiet.id,
    };
  }
  return { outcome: { kind: 'dropped' } };
};

/**
 * A turn begun: it holds its place among the turns from the moment it is
 * sent, and reads as let go of until it ends (`endTurn`): an editor closed
 * while the model still read it never landed it.
 */
export const beginTurn = (
  trace: SessionTrace,
  {
    at,
    day,
    heard,
    text,
  }: {
    /** Epoch milliseconds. */
    readonly at: number;
    readonly day: string;
    readonly heard: Heard | undefined;
    readonly text: string;
  },
): { readonly index: number; readonly trace: SessionTrace } => ({
  index: trace.turns.length,
  trace: {
    ...trace,
    turns: [
      ...trace.turns,
      {
        turn: {
          at: new Date(at).toISOString(),
          day,
          ...(heard === undefined
            ? { input: 'typed' as const }
            : { heard, input: 'dictated' as const, parakeet: heard.apple !== undefined }),
          outcome: { kind: 'dropped' },
          reads: [],
          route: 'first',
          text,
        },
      },
    ],
  },
});

/**
 * A turn over: what it gathered (`notes`) and how it ended: with a
 * message for the field (`message`), with the model unable to answer
 * (`failed`), or taken, which the thread before and after it says
 * (`turnOutcome`); taken without having landed, it was let go of.
 */
export const endTurn = (
  trace: SessionTrace,
  index: number,
  notes: TurnNotes,
  { failed = false, message }: { readonly failed?: boolean; readonly message?: string | undefined },
): SessionTrace => {
  const begun = trace.turns[index];
  if (begun === undefined) {
    return trace;
  }
  const landed =
    notes.landed === undefined ? undefined : turnOutcome(notes.landed.before, notes.landed.after);
  const outcome: SessionOutcome =
    failed || notes.failed === true
      ? { kind: 'failed' }
      : notes.dropped === true
        ? { kind: 'dropped' }
        : message === undefined
          ? (landed?.outcome ?? { kind: 'dropped' })
          : { kind: 'refused', message };
  const taken = !failed && notes.failed !== true && message === undefined;
  const turn: SessionTurn = {
    ...begun.turn,
    ...(notes.freeSlots === undefined ? {} : { freeSlots: notes.freeSlots }),
    ...(notes.invited === undefined || notes.invited.length === 0
      ? {}
      : { invited: notes.invited }),
    outcome,
    ...(notes.place === undefined ? {} : { place: notes.place }),
    reads: notes.reads,
    route: notes.route,
    ...(notes.uninvited === undefined || notes.uninvited.length === 0
      ? {}
      : { uninvited: notes.uninvited }),
  };
  return {
    ...trace,
    turns: trace.turns.map((each, at) =>
      at === index ? { ...(taken && landed?.step ? { step: landed.step } : {}), turn } : each,
    ),
  };
};

/** The other readings offered under words that changed nothing, on the turn that was answered so. */
export const withTracedReadings = (
  trace: SessionTrace,
  step: string,
  readings: ReadonlyArray<SessionReading>,
): SessionTrace =>
  readings.length === 0
    ? trace
    : {
        ...trace,
        turns: trace.turns.map((each) =>
          each.step === step && each.turn.outcome.kind === 'no-change'
            ? {
                ...each,
                turn: {
                  ...each.turn,
                  readings: readings.map(({ does, text }) => ({ does, text })),
                },
              }
            : each,
        ),
      };

/**
 * A choice answered by hand, as the log keeps it: which place among the
 * ones the turn offered the form now holds (none of them: the text kept
 * as said), which contact joined for a name, or that a free slot was
 * taken. `draft`: the focused draft before the pick; `form`: the form
 * after it. Nothing for an edit, or a guest pick that added nobody.
 */
export const tracedPick = (
  trace: SessionTrace,
  draft: Draft | undefined,
  form: FormSnapshot,
  how: HandStep | undefined,
): SessionPick | undefined => {
  if (how?.kind !== 'pick') {
    return undefined;
  }
  const after = trace.turns.length - 1;
  if (how.pick === 'slot') {
    return { after, kind: 'slot' };
  }
  if (how.pick === 'place') {
    const choice = draft?.placeChoice;
    const location = form.item.kind === 'event' ? (form.item.prefill.location ?? '') : '';
    const picked =
      choice === undefined ? undefined : pickedCandidate(choice, location, form.extras?.geo);
    const at =
      choice === undefined || picked === undefined ? -1 : choice.candidates.indexOf(picked);
    return { after, ...(at === -1 ? {} : { candidate: at }), kind: 'place' };
  }
  const had = new Set((draft?.extras?.attendees ?? []).map((guest) => emailKey(guest.email)));
  const joined = (form.extras?.attendees ?? []).find((guest) => !had.has(emailKey(guest.email)));
  return how.name === undefined || joined === undefined
    ? undefined
    : { after, contact: nameWithAddress(joined), kind: 'guest', name: how.name };
};

export const withPick = (trace: SessionTrace, pick: SessionPick | undefined): SessionTrace =>
  pick === undefined ? trace : { ...trace, picks: [...trace.picks, pick] };

/**
 * A draft as the last phrase that made a step left it: what "changed by
 * hand since" is measured from. With no such phrase, the thread as it
 * opened (a saved item), or nothing (a new item no phrase made).
 */
const afterLastPhrase = (state: DraftThreadState, id: string | undefined): Draft | undefined => {
  const at = state.steps.findLastIndex((step) => step.kind === 'phrase');
  const moment = at === -1 ? (state.history[0] ?? state) : (state.history[at + 1] ?? state);
  return moment.drafts.find((draft) => draft.id === id);
};

/** What a pick settles, as a changed part: a contact is a guest, a place the location, a slot the time. */
const PICKED = { guest: 'guests', place: 'location', slot: 'time' } as const;

const repeatOf = (draft: Draft): Readonly<Record<string, unknown>> | undefined => {
  if (draft.item.kind === 'event') {
    return draft.item.prefill.recurrence;
  }
  const repeat = draft.extras?.reminder?.repeat;
  return repeat === undefined || repeat.repeat === 'none' ? undefined : { freq: repeat.repeat };
};

/**
 * An item as it is written: what the form holds of the draft it shows
 * (`form.shown`; the focused one where it names none), and the parts that
 * read otherwise than the last phrase left them (`draftChanges`, by
 * meaning: an edit put back is none). A form saved with no draft behind
 * it (no phrase made one) was all typed by hand.
 */
export const savedItem = (state: DraftThreadState, form: FormSnapshot): TracedSaved => {
  const held =
    form.shown === undefined
      ? state.drafts[state.focused]
      : state.drafts.find((draft) => draft.id === form.shown);
  const written: Draft = {
    ...held,
    ...(form.extras === undefined ? {} : { extras: form.extras }),
    id: held?.id ?? 'form',
    item: form.item,
  };
  // By hand at any point (an edit step's fields, a pick's), and whatever
  // the form holds otherwise than the last phrase left it: a name fixed
  // before a later phrase is a correction too.
  const byHand = state.steps.flatMap((step) =>
    held !== undefined && step.drafts.includes(held.id)
      ? step.kind === 'edit'
        ? step.fields
        : step.kind === 'pick'
          ? [PICKED[step.pick]]
          : []
      : [],
  );
  const since = draftChanges(afterLastPhrase(state, held?.id), written).map(
    (change) => change.field,
  );
  const edited = [...new Set([...byHand, ...since])];
  const repeat = repeatOf(written);
  const base = { edited, ...(repeat === undefined ? {} : { repeat }) };
  const { item } = written;
  if (item.kind === 'task') {
    return {
      draft: held?.id,
      item: {
        ...base,
        ...(written.extras?.undated === true ? {} : { date: item.prefill.date }),
        guests: 0,
        kind: 'task',
        ...(item.prefill.time === undefined ? {} : { startTime: item.prefill.time }),
        title: item.prefill.title,
      },
    };
  }
  const { prefill } = item;
  return {
    draft: held?.id,
    item: {
      ...base,
      date: prefill.date,
      ...(prefill.endDate === undefined || prefill.endDate === prefill.date
        ? {}
        : { endDate: prefill.endDate }),
      ...(prefill.isAllDay ? {} : { endTime: prefill.endTime }),
      guests: (written.extras?.attendees ?? []).length,
      isAllDay: prefill.isAllDay,
      kind: 'event',
      ...(prefill.location === undefined || prefill.location.trim() === ''
        ? {}
        : { location: prefill.location }),
      ...(prefill.isAllDay ? {} : { startTime: prefill.startTime }),
      title: prefill.title,
    },
  };
};

export const withSaved = (trace: SessionTrace, saved: TracedSaved): SessionTrace => ({
  ...trace,
  saved: [...trace.saved, saved],
});

/** `mac-20261126T073512123Z`: who wrote it and when its first phrase was sent. */
const sessionId = (platform: SessionAbout['app']['platform'], startedAt: string): string =>
  `${platform === 'Mac' ? 'mac' : 'iphone'}-${startedAt.replaceAll(/[-:.]/gu, '')}`;

/**
 * The record a thread comes to when its editor closes, or nothing for a
 * thread no phrase was said to: its turns (one whose step is no longer
 * in the thread was taken back), the picks, the items written and how
 * many drafts were left unwritten.
 */
export const finishedSession = (
  trace: SessionTrace,
  {
    about,
    endedAt,
    state,
    timeZone,
  }: {
    readonly about: SessionAbout;
    /** Epoch milliseconds. */
    readonly endedAt: number;
    /** The thread as it ended. */
    readonly state: DraftThreadState;
    readonly timeZone: string;
  },
): AssistantSession | undefined => {
  const [first] = trace.turns;
  if (first === undefined) {
    return undefined;
  }
  const alive = new Set(
    [...state.steps, ...state.ahead.map((gone) => gone.step)].map((step) => step.id),
  );
  const written = new Set(trace.saved.map((saved) => saved.draft));
  return {
    ...about,
    endedAt: new Date(endedAt).toISOString(),
    id: sessionId(about.app.platform, first.turn.at),
    left: state.drafts.filter((draft) => !written.has(draft.id)).length,
    origin: trace.origin,
    picks: trace.picks,
    saved: trace.saved.map((saved) => saved.item),
    startedAt: first.turn.at,
    timeZone,
    turns: trace.turns.map(({ step, turn }) =>
      turn.outcome.kind === 'changed' && step !== undefined && !alive.has(step)
        ? { ...turn, undone: true }
        : turn,
    ),
    v: SESSION_LOG_VERSION,
  };
};
