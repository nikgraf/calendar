import { Contact, GeoLocation, type PlaceCandidate } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import {
  askedAfterTurn,
  editorQuestions,
  isPlaceQuestion,
  openQuestions,
  questionsAsked,
} from './draftQuestions.ts';
import {
  dropInviteeChoice,
  dropPlaceChoice,
  foldForm,
  refineThread,
  startThread,
  stepTo,
} from './draftThread.ts';
import type { QuickAddItem } from './quickAddItem.ts';

const dinner: QuickAddItem = {
  kind: 'event',
  prefill: {
    date: '2026-08-28',
    endTime: '20:00',
    isAllDay: false,
    location: 'Figlmüller',
    startTime: '19:00',
    title: 'Dinner with Teo',
  },
};

/** A Figlmüller found by its words (taken when it is the best one), or a search hit that is not. */
const figl = (address: string, match: PlaceCandidate['match'] = 'words'): PlaceCandidate => ({
  address,
  geo: new GeoLocation({
    lat: address.length,
    lng: 16.37,
    name: 'Figlmüller',
    source: 'Figlmüller',
  }),
  match,
  source: 'mapkit',
});
const contact = (displayName: string, email: string) =>
  new Contact({ displayName, email, id: email, source: 'google' });
const toms = {
  contacts: [
    contact('Tom Brandt', 'tom.brandt@example.com'),
    contact('Tom Weiss', 'tom.weiss@example.com'),
  ],
  name: 'Tom',
};
const nobody = { contacts: [], name: 'Mia' };

/** Stable ids: d1, d2, … in the order they are asked for. */
const ids = () => {
  let count = 0;
  return () => {
    count += 1;
    return `d${String(count)}`;
  };
};

const twoPlaces = { candidates: [figl('Wollzeile 5'), figl('Bäckerstraße 6')], text: 'Figlmüller' };

/** Dinner at Figlmüller, two places and two Toms to choose from. */
const asking = () =>
  startThread([dinner], 'dinner at Figlmüller, invite Tom and Mia', {
    guests: { add: [], choices: [toms, nobody], invited: ['Tom', 'Mia'], remove: [] },
    id: ids(),
    place: twoPlaces,
  });

describe('openQuestions', () => {
  it('asks about a place with more than one candidate, or with none taken', () => {
    expect(isPlaceQuestion(twoPlaces)).toBe(true);
    // One search hit, nothing like the words: not taken, so asked.
    expect(isPlaceQuestion({ candidates: [figl('Wollzeile 5', 'search')], text: 'x' })).toBe(true);
    // One place, taken: the text as said stays a tap away, not a question.
    expect(isPlaceQuestion({ candidates: [figl('Wollzeile 5')], text: 'Figlmüller' })).toBe(false);
  });

  it('asks the place first, then the names that found someone; a name with nobody is a note', () => {
    expect(openQuestions(twoPlaces, [nobody, toms])).toEqual([
      { choice: twoPlaces, kind: 'place' },
      { choice: toms, kind: 'guest' },
    ]);
    expect(openQuestions(undefined, [nobody])).toEqual([]);
  });
});

describe('questionsAsked', () => {
  const open = openQuestions(twoPlaces, [toms]);

  const both = { guests: 1, places: 1 };

  it('numbers the one on show among those asked together', () => {
    expect(questionsAsked(both, open)).toEqual({ current: open[0], number: 1, of: 2 });
    expect(questionsAsked(both, open.slice(1))).toEqual({ current: open[1], number: 2, of: 2 });
    expect(questionsAsked(both, [])).toMatchObject({ current: undefined });
  });

  it('counts the open ones where the draft kept no count', () => {
    expect(questionsAsked(undefined, open)).toMatchObject({ number: 1, of: 2 });
    expect(questionsAsked({ guests: 0, places: 1 }, open)).toMatchObject({ number: 1, of: 2 });
  });

  it('leaves the names out where the calendar cannot invite: the place is 1 of 1', () => {
    const place = openQuestions(twoPlaces, []);
    expect(questionsAsked(both, place, { guests: false })).toMatchObject({ number: 1, of: 1 });
  });
});

describe('editorQuestions', () => {
  const both = { guests: 1, places: 1 };
  const base = {
    applying: false,
    canInvite: true,
    draft: { asked: both, item: dinner, placeChoice: twoPlaces },
    event: true,
    guests: [toms],
    livePlace: twoPlaces,
  };

  it('asks the place the field reads, then the names', () => {
    expect(editorQuestions(base)).toMatchObject({
      current: { choice: twoPlaces, kind: 'place' },
      number: 1,
      of: 2,
    });
  });

  it('asks the draft’s place while the form is still taking the turn in, not the next question first', () => {
    // The field still reads the draft before: the place is not live yet.
    expect(editorQuestions({ ...base, applying: true, livePlace: undefined })).toMatchObject({
      current: { kind: 'place' },
      number: 1,
    });
    expect(editorQuestions({ ...base, livePlace: undefined })).toMatchObject({
      current: { kind: 'guest' },
      number: 2,
    });
  });

  it('leaves out names on a calendar that cannot invite: the place is 1 of 1', () => {
    expect(editorQuestions({ ...base, canInvite: false, guests: [] })).toMatchObject({
      number: 1,
      of: 1,
    });
  });

  it('does not bring back a place the location was edited away from while a turn goes in', () => {
    const edited: QuickAddItem = {
      kind: 'event',
      prefill: { ...dinner.prefill, location: 'Plachutta' },
    };
    const draft = { asked: { guests: 1, places: 0 }, item: edited, placeChoice: twoPlaces };
    expect(editorQuestions({ ...base, applying: true, draft, livePlace: undefined })).toMatchObject(
      { current: { kind: 'guest' }, number: 1, of: 1 },
    );
  });
});

describe('askedAfterTurn', () => {
  it('starts again when a turn brings a question, and keeps the count when it brings none', () => {
    const before = { asked: { guests: 2, places: 0 }, inviteeChoices: [toms] };
    // A phrase about the time: Tom still asked, "2 of 2" stays.
    expect(askedAfterTurn(before, { inviteeChoices: [toms] })).toEqual({ guests: 2, places: 0 });
    // A new place to choose: the two open now are asked together.
    expect(askedAfterTurn(before, { inviteeChoices: [toms], placeChoice: twoPlaces })).toEqual({
      guests: 1,
      places: 1,
    });
    // A new name only.
    const anna = { contacts: toms.contacts, name: 'Anna' };
    expect(askedAfterTurn(before, { inviteeChoices: [toms, anna] })).toEqual({
      guests: 2,
      places: 0,
    });
    expect(askedAfterTurn(undefined, { inviteeChoices: [nobody] })).toBeUndefined();
  });

  it('does not count a place the location was edited away from', () => {
    const edited: QuickAddItem = {
      kind: 'event',
      prefill: { ...dinner.prefill, location: 'Plachutta' },
    };
    // The place still on the draft, the location typed over: only Tom is asked, "1 of 1".
    expect(
      askedAfterTurn(
        { inviteeChoices: [], placeChoice: twoPlaces },
        { inviteeChoices: [toms], item: edited, placeChoice: twoPlaces },
      ),
    ).toEqual({ guests: 1, places: 0 });
  });
});

describe('a draft asks its questions one at a time', () => {
  it('counts what the first phrase asked', () => {
    expect(asking().drafts[0]?.asked).toEqual({ guests: 1, places: 1 });
  });

  it('moves on as each is answered: a place picked, then a contact', () => {
    const id = ids();
    const state = asking();
    // The other Figlmüller picked: a step, and the place question settled with it.
    const baecker = twoPlaces.candidates[1]!;
    const placed = foldForm(
      state,
      {
        extras: { attendees: [], description: '', geo: baecker.geo, reminders: undefined },
        item: dinner,
      },
      { kind: 'pick', pick: 'place' },
      id,
    );
    const draft = placed.drafts[0]!;
    expect(draft.placeChoice).toBeUndefined();
    expect(
      questionsAsked(draft.asked, openQuestions(undefined, draft.inviteeChoices ?? [])),
    ).toEqual({ current: { choice: toms, kind: 'guest' }, number: 2, of: 2 });
    // Going back over the pick asks it again.
    expect(stepTo(placed, 1).drafts[0]?.placeChoice).toEqual(twoPlaces);
    // Tom Brandt picked: nothing is left to ask; Mia stays a note.
    const tom = toms.contacts[0]!;
    const picked = foldForm(
      placed,
      {
        extras: {
          attendees: [{ displayName: tom.displayName, email: tom.email }],
          description: '',
          geo: baecker.geo,
          reminders: undefined,
        },
        item: dinner,
      },
      { kind: 'pick', name: 'Tom', pick: 'guest' },
      id,
    );
    expect(picked.drafts[0]?.inviteeChoices).toEqual([nobody]);
    expect(openQuestions(undefined, picked.drafts[0]?.inviteeChoices ?? [])).toEqual([]);
  });

  it('moves on when one is skipped, the form left as it is', () => {
    const skipped = dropPlaceChoice(asking(), 0);
    const draft = skipped.drafts[0]!;
    expect(
      questionsAsked(draft.asked, openQuestions(undefined, draft.inviteeChoices ?? [])),
    ).toMatchObject({ number: 2, of: 2 });
    expect(dropInviteeChoice(skipped, 0, 'Tom').drafts[0]?.inviteeChoices).toEqual([nobody]);
  });

  it('keeps the count through a phrase about something else', () => {
    const state = dropPlaceChoice(asking(), 0);
    const later: QuickAddItem = {
      kind: 'event',
      prefill: { ...dinner.prefill, endTime: '21:00', startTime: '20:00' },
    };
    const moved = refineThread(state, 'an hour later', [{ id: 'd1', item: later }], ids());
    expect(moved.drafts[0]?.asked).toEqual({ guests: 1, places: 1 });
  });
});
