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

describe('whereOf', () => {
  it('reads a turn that only says where the place is', () => {
    // Observed 2026-11-06: Apple's model put "Vienna" over "Cafe Meek", or changed nothing.
    expect(whereOf("it's in Vienna")).toBe('Vienna');
    // As dictation writes it.
    expect(whereOf('It’s in Vienna.')).toBe('Vienna');
    expect(whereOf('in Vienna')).toBe('Vienna');
    expect(whereOf('in vienna')).toBe('vienna');
    expect(whereOf('it is in New York')).toBe('New York');
    expect(whereOf("it's in Vienna, Austria")).toBe('Vienna, Austria');
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
    ]) {
      expect(whereOf(turn), turn).toBeUndefined();
    }
  });

  it('knows what follows "in" and is no place', () => {
    for (const turn of [
      "it's in person",
      'in Präsenz',
      'in English',
      'in Teams',
      'es ist in Ordnung',
      'in Ruhe',
      'in honor of Anna',
      'in progress',
      'in groups',
      'in Urlaub',
      'in theory',
    ]) {
      expect(whereOf(turn), turn).toBeUndefined();
    }
  });
});

describe('companyOf', () => {
  it('reads a turn that only says who it is with', () => {
    // Observed 2026-11-06: Apple's model wrote "with Stefan" into the location.
    expect(companyOf('with Stefan')).toEqual({ company: 'Stefan', link: 'with' });
    expect(companyOf('With Stefan.')).toEqual({ company: 'Stefan', link: 'with' });
    expect(companyOf('with Stefan and Anna')).toEqual({ company: 'Stefan and Anna', link: 'with' });
    expect(companyOf('with the team')).toEqual({ company: 'the team', link: 'with' });
    expect(companyOf('with my parents')).toEqual({ company: 'my parents', link: 'with' });
    expect(companyOf('and with Anna')).toEqual({ company: 'Anna', link: 'with' });
    expect(companyOf('with Anna from accounting')).toEqual({
      company: 'Anna from accounting',
      link: 'with',
    });
    expect(companyOf('mit Stefan')).toEqual({ company: 'Stefan', link: 'mit' });
    expect(companyOf('mit dem Team')).toEqual({ company: 'dem Team', link: 'mit' });
    expect(companyOf('auch mit Tom')).toEqual({ company: 'Tom', link: 'mit' });
  });

  it('leaves a turn that says more, or names no company, to the model', () => {
    for (const turn of [
      'with a reminder',
      'with reminder',
      'with no reminder',
      'mit Erinnerung',
      'with notes',
      'with video',
      'with a Zoom link',
      'with pleasure',
      'with 5 people',
      'with Stefan at Cafe Meek',
      'with Stefan in Vienna',
      'with Stefan at 8',
      'with Stefan tomorrow',
      'with Stefan on Friday',
      'with Stefan instead',
      'mit Anna um 8',
      'without Stefan',
      'with',
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
  });

  it('puts a where over a place that was itself said as a where', () => {
    // "Berlin, Vienna" is no place: the city is another one.
    expect(
      bareTurn("it's in Vienna", at('Berlin'), { said: ['Conference in Berlin on Friday'] }),
    ).toEqual(at('Vienna'));
    expect(
      bareTurn('in Graz', at('Vienna'), { said: ['Lunch tomorrow at 1', "it's in Vienna"] }),
    ).toEqual(at('Graz'));
    // A venue said after "at", or after "in" with its article, is narrowed.
    expect(
      bareTurn("it's in Vienna", at('Cafe Meek'), { said: ['Lunch tomorrow at 1 at Cafe Meek'] }),
    ).toEqual(at('Cafe Meek, Vienna'));
    expect(
      bareTurn('es ist in Wien', at('Figlmüller'), {
        said: ['Abendessen am Freitag im Figlmüller'],
      }),
    ).toEqual(at('Figlmüller, Wien'));
    // The latest words that hold the place decide.
    expect(
      bareTurn("it's in Vienna", at('Berlin'), {
        said: ['Conference in Berlin on Friday', 'at Berlin instead'],
      }),
    ).toEqual(at('Berlin, Vienna'));
    // Part of another word is not the place.
    expect(
      bareTurn("it's in Vienna", at('Berlin'), { said: ['Dinner in Berliner Platz at Berlin'] }),
    ).toEqual(at('Berlin, Vienna'));
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
    // A where the first turn set alone is a where: the next one takes its place.
    expect(
      bareTurn("it's in Graz", at('Vienna'), { said: ['Lunch at Cafe Meek', 'in Vienna'] }),
    ).toEqual(at('Graz'));
  });

  it('joins the company to the title and leaves the place alone', () => {
    expect(bareTurn('with Stefan', LUNCH)).toEqual({ ...LUNCH, title: 'Lunch with Stefan' });
    expect(bareTurn('With Stefan.', at('Cafe Meek'))).toEqual({
      ...at('Cafe Meek'),
      title: 'Lunch with Stefan',
    });
    expect(bareTurn('mit Anna', { ...LUNCH, title: 'Abendessen' })).toEqual({
      ...LUNCH,
      title: 'Abendessen mit Anna',
    });
    // Company the title has is joined, in the turn's language.
    expect(bareTurn('with Anna', { ...LUNCH, title: 'Lunch with Stefan' })).toEqual({
      ...LUNCH,
      title: 'Lunch with Stefan and Anna',
    });
    expect(bareTurn('auch mit Tom', { ...LUNCH, title: 'Essen mit Anna' })).toEqual({
      ...LUNCH,
      title: 'Essen mit Anna und Tom',
    });
    // Said already: nothing moves.
    const withStefan = { ...LUNCH, title: 'Lunch with Stefan' };
    expect(bareTurn('with Stefan', withStefan)).toBe(withStefan);
  });

  it('reads no place into a to-do, and still its company', () => {
    const todo = { ...LUNCH, title: 'Call the bank' };
    expect(bareTurn("it's in Vienna", todo, { places: false })).toBeUndefined();
    expect(bareTurn('with Stefan', todo, { places: false })).toEqual({
      ...todo,
      title: 'Call the bank with Stefan',
    });
  });

  it('is no bare turn for anything else', () => {
    expect(bareTurn('make it 8pm', LUNCH)).toBeUndefined();
    expect(bareTurn('at the office instead', at('Cafe Meek'))).toBeUndefined();
    expect(bareTurn('remove the location', at('Cafe Meek'))).toBeUndefined();
    expect(bareTurn('invite Stefan', LUNCH)).toBeUndefined();
  });
});
