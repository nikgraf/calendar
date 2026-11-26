import type { SessionAbout } from '@calendar/ai';
import { GeoLocation, type PlaceCandidate } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import {
  type DraftThreadState,
  EMPTY_THREAD,
  foldForm,
  refineThread,
  removeDraft,
  startThread,
  undoTurn,
} from './draftThread.ts';
import type { QuickAddItem } from './quickAddItem.ts';
import {
  beginTurn,
  EMPTY_TRACE,
  endTurn,
  finishedSession,
  openRead,
  savedItem,
  sessionInvitees,
  sessionPlace,
  type SessionTrace,
  tracedPick,
  turnNotes,
  withPick,
  withSaved,
  withTracedReadings,
} from './sessionTrace.ts';

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
const later: QuickAddItem = {
  kind: 'event',
  prefill: { ...dinner.prefill, endTime: '21:00', startTime: '20:00' },
};

const ids = () => {
  let count = 0;
  return () => {
    count += 1;
    return `d${String(count)}`;
  };
};

const ABOUT: SessionAbout = { app: { platform: 'iPhone', version: '0.1.0 (60)' }, model: 'v2' };
const AT = Date.UTC(2026, 7, 27, 9, 0, 0);

const candidate = (name: string, match: PlaceCandidate['match']): PlaceCandidate => ({
  geo: new GeoLocation({ lat: 48.2, lng: 16.37, name, source: name }),
  match,
  source: 'mapkit',
});

/** A turn sent, read and landed: the trace and the thread after it. */
const turn = (
  trace: SessionTrace,
  before: DraftThreadState,
  after: DraftThreadState,
  text: string,
  options: { readonly heard?: boolean; readonly message?: string } = {},
): SessionTrace => {
  const begun = beginTurn(trace, {
    at: AT,
    day: '2026-08-27',
    heard: options.heard ? { apple: text.toUpperCase(), segments: [{ text }], text } : undefined,
    text,
  });
  const notes = turnNotes();
  notes.route = before.drafts.length === 0 ? 'first' : 'change';
  const read = openRead(notes);
  read.onExchange?.({ answer: { title: 'x' }, prompt: `Phrase: ${text}` });
  read.done({ kind: 'parsed', prefill: dinner.prefill as never });
  if (options.message === undefined) {
    notes.landed = { after, before };
  }
  return endTurn(begun.trace, begun.index, notes, { message: options.message });
};

describe('finishedSession', () => {
  it('is nothing for a thread no phrase was said to', () => {
    expect(
      finishedSession(EMPTY_TRACE, {
        about: ABOUT,
        endedAt: AT,
        state: EMPTY_THREAD,
        timeZone: 'Europe/Vienna',
      }),
    ).toBeUndefined();
  });

  it('keeps each turn with its reads and outcome, and the item as saved untouched', () => {
    const id = ids();
    const started = startThread([dinner], 'dinner with teo friday', { id });
    const refined = refineThread(started, 'make it 8', [{ id: 'd1', item: later }], id);
    let trace = turn(EMPTY_TRACE, EMPTY_THREAD, started, 'dinner with teo friday', {
      heard: true,
    });
    trace = turn(trace, started, refined, 'make it 8');
    trace = withSaved(trace, savedItem(refined, { item: later }));
    const session = finishedSession(trace, {
      about: ABOUT,
      endedAt: AT + 5000,
      state: refined,
      timeZone: 'Europe/Vienna',
    });
    expect(session).toMatchObject({
      app: { platform: 'iPhone' },
      id: 'iphone-20260827T090000000Z',
      left: 0,
      origin: 'new',
      saved: [
        { edited: [], guests: 0, kind: 'event', startTime: '20:00', title: 'Dinner with Teo' },
      ],
      timeZone: 'Europe/Vienna',
      v: 1,
    });
    expect(session?.turns[0]).toMatchObject({
      input: 'dictated',
      outcome: { kind: 'changed' },
      parakeet: true,
      reads: [{ answer: { title: 'x' }, prompt: 'Phrase: dinner with teo friday' }],
      route: 'first',
    });
    expect(session?.turns[1]).toMatchObject({
      input: 'typed',
      outcome: { kind: 'changed', summary: '→ 20:00–21:00' },
      route: 'change',
    });
    expect(session?.turns[1]?.undone).toBeUndefined();
  });

  it('names what was changed by hand after the last phrase', () => {
    const id = ids();
    const started = startThread([dinner], 'dinner friday', { id });
    const retitled: QuickAddItem = {
      kind: 'event',
      prefill: { ...later.prefill, title: 'Dinner' },
    };
    const edited = foldForm(started, { item: retitled }, { kind: 'edit' }, id);
    expect(savedItem(edited, { item: retitled }).item.edited).toEqual(['title', 'time']);
  });

  it('names an edit made by hand before a later phrase', () => {
    const id = ids();
    const started = startThread([dinner], 'dinner with teo friday', { id });
    const fixed: QuickAddItem = {
      kind: 'event',
      prefill: { ...dinner.prefill, title: 'Dinner with Theo' },
    };
    const edited = foldForm(started, { item: fixed }, { kind: 'edit' }, id);
    const moved: QuickAddItem = {
      kind: 'event',
      prefill: { ...later.prefill, title: 'Dinner with Theo' },
    };
    const refined = refineThread(edited, 'make it 8', [{ id: 'd1', item: moved }], id);
    expect(savedItem(refined, { item: moved }).item.edited).toEqual(['title']);
  });

  it('fails a change turn whose model could not answer, though it answered with a message', () => {
    const begun = beginTurn(EMPTY_TRACE, {
      at: AT,
      day: '2026-08-27',
      heard: undefined,
      text: 'x',
    });
    const notes = turnNotes();
    notes.failed = true;
    const ended = endTurn(begun.trace, begun.index, notes, {
      message: 'On-device model unavailable.',
    });
    expect(ended.turns[0]?.turn.outcome).toEqual({ kind: 'failed' });
  });

  it('fails a turn whose model threw mid-answer, though the reader refused it', () => {
    const begun = beginTurn(EMPTY_TRACE, {
      at: AT,
      day: '2026-08-27',
      heard: undefined,
      text: 'x',
    });
    const notes = turnNotes();
    const read = openRead(notes);
    read.onExchange?.({ failed: true, prompt: 'Phrase: x' });
    read.done({ kind: 'rejected', reason: "That couldn't be read — try rephrasing." });
    const ended = endTurn(begun.trace, begun.index, notes, { message: 'x' });
    expect(ended.turns[0]?.turn).toMatchObject({
      outcome: { kind: 'failed' },
      reads: [{ prompt: 'Phrase: x' }],
    });
  });

  it('keeps a turn let go of with a message as dropped', () => {
    const begun = beginTurn(EMPTY_TRACE, {
      at: AT,
      day: '2026-08-27',
      heard: undefined,
      text: 'x',
    });
    const notes = turnNotes();
    notes.dropped = true;
    expect(
      endTurn(begun.trace, begun.index, notes, { message: 'send it again' }).turns[0]?.turn.outcome,
    ).toEqual({ kind: 'dropped' });
  });

  it('takes back a landing its draft was removed under, once the real landing is known', () => {
    const id = ids();
    const planning: QuickAddItem = {
      kind: 'event',
      prefill: { ...dinner.prefill, title: 'Planning' },
    };
    const started = startThread([dinner, planning], 'dinner and planning', { id });
    const read = refineThread(started, 'make it 8', [{ id: 'd1', item: later }], id);
    const begun = beginTurn(EMPTY_TRACE, {
      at: AT,
      day: '2026-08-27',
      heard: undefined,
      text: 'make it 8',
    });
    const notes = turnNotes();
    notes.landed = { after: read, before: started };
    let trace = endTurn(begun.trace, begun.index, notes, {});
    expect(trace.turns[0]?.turn.outcome.kind).toBe('changed');
    // The draft was removed while the model read: the change lands on nothing.
    const removed = removeDraft(started, 0);
    notes.landed = {
      after: refineThread(removed, 'make it 8', [{ id: 'd1', item: later }], id),
      before: removed,
    };
    trace = endTurn(trace, begun.index, notes, {});
    expect(trace.turns[0]?.turn.outcome).toEqual({ kind: 'dropped' });
    expect(trace.turns[0]?.step).toBeUndefined();
  });

  it('marks a turn Undo took back, and one answered with a message', () => {
    const id = ids();
    const started = startThread([dinner], 'dinner friday', { id });
    const refined = refineThread(started, 'make it 8', [{ id: 'd1', item: later }], id);
    let trace = turn(EMPTY_TRACE, EMPTY_THREAD, started, 'dinner friday');
    trace = turn(trace, started, refined, 'make it 8');
    trace = turn(trace, refined, refined, 'invite bob', {
      message: 'Apple calendars hold no guests.',
    });
    const session = finishedSession(trace, {
      about: ABOUT,
      endedAt: AT,
      state: undoTurn(refined),
      timeZone: 'UTC',
    });
    expect(session?.turns.map((each) => [each.outcome.kind, each.undone])).toEqual([
      ['changed', undefined],
      ['changed', true],
      ['refused', undefined],
    ]);
    expect(session?.saved).toEqual([]);
  });

  it('keeps a turn the editor closed on as let go of', () => {
    const begun = beginTurn(EMPTY_TRACE, {
      at: AT,
      day: '2026-08-27',
      heard: undefined,
      text: 'x',
    });
    const session = finishedSession(begun.trace, {
      about: ABOUT,
      endedAt: AT,
      state: EMPTY_THREAD,
      timeZone: 'UTC',
    });
    expect(session?.turns[0]?.outcome).toEqual({ kind: 'dropped' });
  });

  it('keeps the words that changed nothing, with the readings offered under them', () => {
    const id = ids();
    const started = startThread([dinner], 'dinner friday', { id });
    const quiet = refineThread(started, 'at 7', [{ id: 'd1', item: dinner }], id);
    const noChange = quiet.noChange.at(-1)!;
    let trace = turn(EMPTY_TRACE, EMPTY_THREAD, started, 'dinner friday');
    trace = turn(trace, started, quiet, 'at 7', { heard: true });
    trace = withTracedReadings(trace, noChange.id, [{ does: '→ 13:00–14:00', text: 'at 1' }]);
    const session = finishedSession(trace, {
      about: ABOUT,
      endedAt: AT,
      state: quiet,
      timeZone: 'UTC',
    });
    expect(session?.turns[1]).toMatchObject({
      outcome: { kind: 'no-change' },
      readings: [{ does: '→ 13:00–14:00', text: 'at 1' }],
    });
  });

  it('fails a turn whose model threw', () => {
    const begun = beginTurn(EMPTY_TRACE, {
      at: AT,
      day: '2026-08-27',
      heard: undefined,
      text: 'x',
    });
    const failed = endTurn(begun.trace, begun.index, turnNotes(), { failed: true });
    expect(failed.turns[0]?.turn.outcome).toEqual({ kind: 'failed' });
  });
});

describe('places, guests and picks', () => {
  it('keeps every candidate and the one taken unasked', () => {
    const place = sessionPlace({
      candidates: [candidate('Figlmüller Bäckerstraße', 'words'), candidate('Figlmüller', 'exact')],
      text: 'Figlmüller',
    });
    expect(place?.candidates.map((each) => each.name)).toEqual([
      'Figlmüller Bäckerstraße',
      'Figlmüller',
    ]);
    expect(place?.taken).toBeTypeOf('number');
    expect(sessionPlace({ candidates: [], text: '' })).toBeUndefined();
  });

  it('pairs each invited name with whom it found', () => {
    expect(
      sessionInvitees({
        add: [{ displayName: 'Tom Baker', email: 'tom@example.com' }],
        choices: [{ contacts: [], name: 'Sarah' }],
        invited: ['Sarah', 'Tom'],
        remove: [],
      }),
    ).toEqual([
      { choices: [], name: 'Sarah' },
      { name: 'Tom', taken: 'Tom Baker (tom@example.com)' },
    ]);
  });

  it('records which offered place was picked, or the text kept', () => {
    const id = ids();
    const offered = [candidate('Café Central', 'words'), candidate('Café Sperl', 'search')];
    const started = startThread(
      [{ kind: 'event', prefill: { ...dinner.prefill, location: 'Cafe Central' } }],
      'dinner at cafe central',
      { id, place: { candidates: offered, text: 'Cafe Central' } },
    );
    const draft = started.drafts[0]!;
    const sperl = offered[1]!.geo;
    const picked = tracedPick(
      EMPTY_TRACE,
      draft,
      {
        extras: { attendees: [], description: '', geo: sperl, reminders: undefined },
        item: { kind: 'event', prefill: { ...dinner.prefill, location: sperl.source } },
      },
      { kind: 'pick', pick: 'place' },
    );
    expect(picked).toEqual({ after: -1, candidate: 1, kind: 'place' });
    const asSaid = tracedPick(
      EMPTY_TRACE,
      draft,
      { item: { kind: 'event', prefill: { ...dinner.prefill, location: 'Cafe Central' } } },
      { kind: 'pick', pick: 'place' },
    );
    expect(asSaid).toEqual({ after: -1, kind: 'place' });
    expect(withPick(EMPTY_TRACE, undefined)).toBe(EMPTY_TRACE);
    expect(tracedPick(EMPTY_TRACE, draft, { item: dinner }, { kind: 'edit' })).toBeUndefined();
  });
});
