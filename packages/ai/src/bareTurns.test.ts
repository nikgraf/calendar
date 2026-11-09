import { describe, expect, it } from 'vite-plus/test';
import { bareTurn, companyOf, whereOf } from './bareTurns.ts';
import type { QuickAddPrefill } from './normalizeQuickAdd.ts';

const LUNCH: QuickAddPrefill = {
  date: '2026-08-23',
  endTime: '14:00',
  isAllDay: false,
  startTime: '13:00',
  title: 'Lunch',
};

const at = (location: string): QuickAddPrefill => ({ ...LUNCH, location });
const titled = (title: string): QuickAddPrefill => ({ ...LUNCH, title });

describe('whereOf', () => {
  it('reads a turn that only says where the place is', () => {
    // Observed 2026-11-06: Apple's model put "Vienna" over "Cafe Meek", or changed nothing.
    expect(whereOf("it's in Vienna")).toBe('Vienna');
    // As dictation writes it.
    expect(whereOf('It’s in Vienna.')).toBe('Vienna');
    expect(whereOf('Its in Vienna!')).toBe('Vienna');
    expect(whereOf('in Vienna')).toBe('Vienna');
    expect(whereOf('in vienna')).toBe('vienna');
    expect(whereOf('it is in New York')).toBe('New York');
    expect(whereOf('no, in Neubau')).toBe('Neubau');
    expect(whereOf('in St. Pölten')).toBe('St. Pölten');
    expect(whereOf('in Frankfurt am Main')).toBe('Frankfurt am Main');
    expect(whereOf('es ist in Wien')).toBe('Wien');
    expect(whereOf('ist in Salzburg')).toBe('Salzburg');
  });

  it('reads "the one" and what leads to where it is', () => {
    expect(whereOf('the one in Berlin')).toBe('Berlin');
    expect(whereOf('I mean the one in Neubau')).toBe('Neubau');
    expect(whereOf('The one on Mariahilfer Straße')).toBe('Mariahilfer Straße');
    expect(whereOf('the one at the airport')).toBe('airport');
    expect(whereOf('the one near the opera')).toBe('opera');
    expect(whereOf('the one in the city center')).toBe('city center');
    expect(whereOf('das in der Bäckerstraße')).toBe('Bäckerstraße');
    expect(whereOf('der am Flughafen')).toBe('Flughafen');
    expect(whereOf('das beim Bahnhof')).toBe('Bahnhof');
  });

  it('hears through what a turn ends in to be polite', () => {
    // Review: "in Vienna please" made the place "Cafe Meek, Vienna please".
    expect(whereOf('in Vienna please')).toBe('Vienna');
    expect(whereOf('in Vienna, please.')).toBe('Vienna');
    expect(whereOf('in Wien bitte')).toBe('Wien');
    expect(whereOf('the one in Berlin, thanks')).toBe('Berlin');
  });

  it('leaves a venue of its own, another place and a replacement to the model', () => {
    for (const turn of [
      'in the office',
      'im Büro',
      'in der Praxis Dr. Huber',
      'in the city center',
      'at Café Central',
      'in Vienna instead',
      'in Room 4',
      'in front of the opera',
      'the one with the garden',
      'in Vienna at 8',
      'in Berlin for two hours',
      'in',
      'the one in',
      'das ist gut',
      'please',
    ]) {
      expect(whereOf(turn), turn).toBeUndefined();
    }
  });

  it('leaves a turn that asks for a second thing to the model', () => {
    // Review: the second clause was pasted into the location and never done.
    for (const turn of [
      "it's in Vienna, invite Stefan",
      'in Vienna, add Stefan',
      'in Vienna, Stefan too',
      'in Vienna, busy',
      'in Vienna, both',
      'in Vienna, Austria',
      'the one in Vienna, Austria',
      'in Vienna and invite Anna',
      'in Vienna make it longer',
      'in Vienna call it offsite',
      'in Vienna without Anna',
      'in Vienna not Graz',
    ]) {
      expect(whereOf(turn), turn).toBeUndefined();
    }
  });

  it('hears a when after "in" and after "the one" as a when', () => {
    for (const turn of [
      'in March',
      'in May',
      'in the morning',
      'in 2 hours',
      'in two hours',
      'in a week',
      'in an hour',
      'in zwei Wochen',
      'in einer Stunde',
      'in 10 Minuten',
      'in summer',
      'in Vienna tomorrow',
      'every week in Vienna',
      'the one on Friday',
      'the one at 7',
      'the one at noon',
      'the one in the morning',
      'the one tomorrow',
      'die am Montag',
      'das am Abend',
      'der um 8',
      // Review: whens the when-readers do not know.
      'the one on the weekend',
      'das am Wochenende',
      'in Easter week',
      'the one on my birthday',
    ]) {
      expect(whereOf(turn), turn).toBeUndefined();
    }
  });

  it('knows what follows "in" and is no place', () => {
    for (const turn of [
      "it's in person",
      'in Präsenz',
      'in English',
      'in Dutch',
      'in Teams',
      "it's in Google Meet",
      'the one on Google Meet',
      'in Microsoft Teams',
      'es ist in Ordnung',
      'in Ruhe',
      'in honor of Anna',
      'in progress',
      'in groups',
      'in Urlaub',
      'in theory',
      'in purple',
      'in Rot',
      // Review: where the speaker is names no place.
      'the one near me',
      'the one near here',
      'the one close to us',
      'the one near home',
      'the one at work',
      'das in der Nähe',
      'die in meiner Nähe',
      'die bei uns',
      'das bei mir',
    ]) {
      expect(whereOf(turn), turn).toBeUndefined();
    }
  });
});

const company = (people: ReadonlyArray<string>, link: 'mit' | 'with' = 'with') => ({
  corrects: false,
  link,
  people,
});

describe('companyOf', () => {
  it('reads a turn that only says who it is with', () => {
    // Observed 2026-11-06: Apple's model wrote "with Stefan" into the location.
    expect(companyOf('with Stefan')).toEqual(company(['Stefan']));
    expect(companyOf('With Stefan.')).toEqual(company(['Stefan']));
    expect(companyOf('with Stefan and Anna')).toEqual(company(['Stefan', 'Anna']));
    expect(companyOf('with Stefan & Anna')).toEqual(company(['Stefan', 'Anna']));
    expect(companyOf('with the team')).toEqual(company(['the team']));
    expect(companyOf('with my parents')).toEqual(company(['my parents']));
    expect(companyOf('with Anna Lee')).toEqual(company(['Anna Lee']));
    expect(companyOf('and with Anna')).toEqual(company(['Anna']));
    expect(companyOf('mit Stefan')).toEqual(company(['Stefan'], 'mit'));
    expect(companyOf('mit dem Team')).toEqual(company(['dem Team'], 'mit'));
    expect(companyOf('mit Anna und Tom')).toEqual(company(['Anna', 'Tom'], 'mit'));
    expect(companyOf('auch mit Tom')).toEqual(company(['Tom'], 'mit'));
  });

  it('hears through what a turn ends in, and a correction in what it opens with', () => {
    // Review: "With Stefan please." made the title "Lunch with Stefan please".
    expect(companyOf('With Stefan please.')).toEqual(company(['Stefan']));
    expect(companyOf('with Stefan too')).toEqual(company(['Stefan']));
    expect(companyOf('with Stefan as well')).toEqual(company(['Stefan']));
    expect(companyOf('mit Tom auch')).toEqual(company(['Tom'], 'mit'));
    expect(companyOf('no, with Anna')).toEqual({ corrects: true, link: 'with', people: ['Anna'] });
    expect(companyOf('nein, mit Anna')).toEqual({ corrects: true, link: 'mit', people: ['Anna'] });
    expect(companyOf('actually with Anna')?.corrects).toBe(true);
  });

  it('leaves a turn that says more, or names no company, to the model', () => {
    for (const turn of [
      'with a reminder',
      'with reminder',
      'with no reminder',
      'with an email reminder',
      'mit Erinnerung',
      'mit E-Mail-Erinnerung',
      'mit Push-Benachrichtigung',
      'mit dem Titel Teamessen',
      'with notes',
      'with video',
      'with a Zoom link',
      'with a Google Meet link',
      'with Microsoft Teams',
      'with a meeting link',
      'with conferencing',
      'with Webex',
      'with Discord',
      'with pleasure',
      'with 5 people',
      'with Stefan at Cafe Meek',
      'with Stefan in Vienna',
      'with Stefan at 8',
      'with Stefan tomorrow',
      'with Stefan on Friday',
      'with Stefan instead',
      'with Anna from accounting',
      'with the whole design team',
      'mit Anna um 8',
      'without Stefan',
      'with',
      'with and Anna',
      // Review: a second thing asked in the same breath was pasted into the title.
      'with Stefan, invite Anna',
      'with Stefan and invite Anna',
      'with Stefan and remove Anna',
      'with Stefan, remove the location',
      'with Stefan, make it longer',
      'with Stefan, earlier',
      'with Stefan earlier',
      'with Stefan, no location',
      'with Stefan, tentative',
      'with Stefan, Anna and Tom',
      'with Stefan and call it team lunch',
      'with both',
    ]) {
      expect(companyOf(turn), turn).toBeUndefined();
    }
  });
});

describe('bareTurn', () => {
  it('adds where to the place the draft has', () => {
    expect(bareTurn("it's in Vienna", at('Cafe Meek'))).toEqual(at('Cafe Meek, Vienna'));
    expect(bareTurn('the one in Berlin', at('Hard Rock Cafe'))).toEqual(
      at('Hard Rock Cafe, Berlin'),
    );
    expect(bareTurn('das in der Bäckerstraße', at('Figlmüller'))).toEqual(
      at('Figlmüller, Bäckerstraße'),
    );
    expect(bareTurn('in Vienna please', at('Cafe Meek'))).toEqual(at('Cafe Meek, Vienna'));
    // Nothing else moves.
    expect(bareTurn("it's in Vienna", { ...at('Cafe Meek'), title: 'Lunch with Stefan' })).toEqual({
      ...at('Cafe Meek, Vienna'),
      title: 'Lunch with Stefan',
    });
  });

  it('sets where alone on a draft without a place', () => {
    expect(bareTurn("it's in Vienna", LUNCH)).toEqual(at('Vienna'));
    expect(bareTurn('the one in Berlin', LUNCH)).toEqual(at('Berlin'));
    expect(bareTurn('in Wien', at('  '))).toEqual(at('Wien'));
  });

  it('adds to the place as said, not to the address a lookup wrote', () => {
    const taken = at('Hard Rock Cafe, Rotenturmstraße 25, 1010 Vienna, Austria');
    expect(bareTurn("it's in Berlin", taken, { placeSaid: 'Hard Rock Cafe' })).toEqual(
      at('Hard Rock Cafe, Berlin'),
    );
    // A place that is there already stays as it is, the same object.
    expect(bareTurn("it's in Vienna", taken, { placeSaid: 'Hard Rock Cafe' })).toBe(taken);
    expect(bareTurn("it's in vienna", at('Cafe Meek, Vienna'))).toEqual(at('Cafe Meek, Vienna'));
    // A name that holds a city says nothing of where it is: "Vienna Cafe" may stand in Graz.
    expect(bareTurn("it's in Vienna", at('Vienna Cafe'))).toEqual(at('Vienna Cafe, Vienna'));
    expect(bareTurn("it's in Berlin", taken, { placeSaid: 'Hard Rock Cafe Berlin' })).toEqual(
      at('Hard Rock Cafe Berlin, Berlin'),
    );
    // Review: a word of a part is not the part ("York" of "New York").
    const newYork = at('Hard Rock Cafe, 1501 Broadway, New York, NY 10036, United States');
    expect(bareTurn('the one in York', newYork, { placeSaid: 'Hard Rock Cafe' })).toEqual(
      at('Hard Rock Cafe, York'),
    );
    expect(bareTurn('the one in New York', newYork, { placeSaid: 'Hard Rock Cafe' })).toBe(newYork);
  });

  it('takes a second where in place of the first', () => {
    expect(
      bareTurn("it's in Graz", at('Cafe Meek, Vienna'), {
        said: ['Lunch at Cafe Meek tomorrow', "it's in Vienna"],
      }),
    ).toEqual(at('Cafe Meek, Graz'));
    // The lookup took a place for the narrowed text: its words as said carry the first where.
    expect(
      bareTurn('the one in Graz', at('Meek Bar, Hauptplatz 1, 1010 Vienna, Austria'), {
        placeSaid: 'Cafe Meek, Vienna',
        said: ['Lunch at Cafe Meek tomorrow', "it's in Vienna"],
      }),
    ).toEqual(at('Cafe Meek, Graz'));
    // Review: a note or notifications said with the first where hid it.
    expect(
      bareTurn("it's in Graz", at('Cafe Meek, Vienna'), {
        said: ['at Cafe Meek', "it's in Vienna, remind me 10 minutes before"],
      }),
    ).toEqual(at('Cafe Meek, Graz'));
    // A where a bare turn set alone is all where: the next one takes its place.
    expect(
      bareTurn("it's in Vienna", at('Berlin'), { said: ['Conference on Friday', 'in Berlin'] }),
    ).toEqual(at('Vienna'));
    // The same word in a name is the name's ("Hard Rock Cafe Berlin").
    expect(bareTurn('in Hamburg', at('Hard Rock Cafe Berlin'), { said: ['in Berlin'] })).toEqual(
      at('Hard Rock Cafe Berlin, Hamburg'),
    );
  });

  it('takes a correction in place of the where the place was said with', () => {
    // Review: "Lunch at Cafe Meek, Vienna", then "no, in Graz" read "Cafe Meek, Vienna, Graz".
    expect(
      bareTurn('no, in Graz', at('Cafe Meek, Vienna'), {
        said: ['Lunch at Cafe Meek, Vienna tomorrow'],
      }),
    ).toEqual(at('Cafe Meek, Graz'));
    // Without the "no" it says more of the same place.
    expect(
      bareTurn("it's in Austria", at('Cafe Meek, Vienna'), {
        said: ['Lunch at Cafe Meek, Vienna tomorrow'],
      }),
    ).toEqual(at('Cafe Meek, Vienna, Austria'));
    // A place said alone is narrowed, corrected or not; an address keeps its parts.
    expect(bareTurn('no, in Vienna', at('Cafe Meek'))).toEqual(at('Cafe Meek, Vienna'));
    expect(bareTurn('no, in Wien', at('Hauptstraße 1, 8010 Graz, Austria'))).toEqual(
      at('Hauptstraße 1, 8010 Graz, Austria, Wien'),
    );
  });

  it('narrows a place whatever word it was said after', () => {
    // Review: "Lunch in Cafe Meek" lost its venue to the where ("in" before a venue is common).
    expect(
      bareTurn("it's in Vienna", at('Cafe Meek'), { said: ['Lunch in Cafe Meek tomorrow'] }),
    ).toEqual(at('Cafe Meek, Vienna'));
    expect(
      bareTurn('the one in Neubau', at('Starbucks'), { said: ['Coffee in Starbucks at 9'] }),
    ).toEqual(at('Starbucks, Neubau'));
    expect(
      bareTurn("it's in Neubau", at('Vienna'), { said: ['Lunch in Vienna tomorrow'] }),
    ).toEqual(at('Vienna, Neubau'));
  });

  it('joins the company to the title and leaves the place alone', () => {
    expect(bareTurn('with Stefan', LUNCH)).toEqual(titled('Lunch with Stefan'));
    expect(bareTurn('With Stefan please.', at('Cafe Meek'))).toEqual({
      ...at('Cafe Meek'),
      title: 'Lunch with Stefan',
    });
    expect(bareTurn('mit Anna', titled('Abendessen'))).toEqual(titled('Abendessen mit Anna'));
    expect(bareTurn('with Stefan and Anna', LUNCH)).toEqual(titled('Lunch with Stefan and Anna'));
    // Company the title has is joined, in the turn's language.
    expect(bareTurn('with Anna', titled('Lunch with Stefan'))).toEqual(
      titled('Lunch with Stefan and Anna'),
    );
    expect(bareTurn('auch mit Tom', titled('Essen mit Anna'))).toEqual(
      titled('Essen mit Anna und Tom'),
    );
    // Said already: nothing moves.
    const withStefan = titled('Lunch with Stefan');
    expect(bareTurn('with Stefan', withStefan)).toBe(withStefan);
  });

  it('adds only who the title does not name yet', () => {
    // Review: "with Stefan and Anna" on "Lunch with Stefan" doubled Stefan.
    expect(bareTurn('with Stefan and Anna', titled('Lunch with Stefan'))).toEqual(
      titled('Lunch with Stefan and Anna'),
    );
    expect(bareTurn('with Anna and Stefan', titled('Lunch with Stefan'))).toEqual(
      titled('Lunch with Stefan and Anna'),
    );
    expect(bareTurn('mit Tom und Anna', titled('Essen mit Anna'))).toEqual(
      titled('Essen mit Anna und Tom'),
    );
  });

  it('puts a correction in the place of the company the title has', () => {
    // Review: "no, with Anna" on "Lunch with Stefan" read "Lunch with Stefan and Anna".
    expect(bareTurn('no, with Anna', titled('Lunch with Stefan'))).toEqual(
      titled('Lunch with Anna'),
    );
    expect(bareTurn('actually with Anna and Tom', titled('Lunch with Stefan'))).toEqual(
      titled('Lunch with Anna and Tom'),
    );
    expect(bareTurn('nein, mit Anna', titled('Essen mit Tom'))).toEqual(titled('Essen mit Anna'));
    // No company to correct: it joins the title.
    expect(bareTurn('no, with Anna', LUNCH)).toEqual(titled('Lunch with Anna'));
    // More than company after the title's "with": the model's to read.
    expect(bareTurn('no, with Anna', titled('Lunch with Stefan at the park'))).toBeUndefined();
  });

  it('leaves a draft without a title to the model', () => {
    // Review: the title came out " with Stefan".
    expect(bareTurn('with Stefan', titled(''))).toBeUndefined();
    expect(bareTurn('with Stefan', titled('  '))).toBeUndefined();
  });

  it('reads no place into a to-do, and still its company', () => {
    const todo = titled('Call the bank');
    expect(bareTurn("it's in Vienna", todo, { places: false })).toBeUndefined();
    expect(bareTurn('with Stefan', todo, { places: false })).toEqual(
      titled('Call the bank with Stefan'),
    );
  });

  it('is no bare turn for anything else', () => {
    expect(bareTurn('make it 8pm', LUNCH)).toBeUndefined();
    expect(bareTurn('at the office instead', at('Cafe Meek'))).toBeUndefined();
    expect(bareTurn('remove the location', at('Cafe Meek'))).toBeUndefined();
    expect(bareTurn('invite Stefan', LUNCH)).toBeUndefined();
    expect(bareTurn('with Stefan, invite Anna', LUNCH)).toBeUndefined();
    expect(bareTurn("it's in Vienna, invite Stefan", at('Cafe Meek'))).toBeUndefined();
  });
});
