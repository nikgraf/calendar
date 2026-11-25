import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { filterCases, loadCases, loadContacts, localeOf } from './cases.ts';

const BENCH_DIR = import.meta.dirname;

const caseDir = (files: Readonly<Record<string, unknown>>): string => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-cases-'));
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof content === 'string' ? content : JSON.stringify(content));
  }
  return dir;
};

describe('loadCases', () => {
  it('reads every case file by name, with the defaults filled in', () => {
    const dir = caseDir({
      'a.json': {
        lang: 'en',
        turns: [{ expect: { weekday: 5 }, input: { text: 'Dinner Friday' } }],
      },
      'b-notes.txt': 'not a case',
      'b.json': {
        contacts: 'family',
        lang: 'de',
        locale: 'de-AT',
        tags: ['flow'],
        turns: [{ expect: { title: ['a', 'b'] }, input: { audio: 'b-1.m4a', transcript: 'x' } }],
      },
      'c.json': {
        lang: 'en',
        turns: [
          { expect: { kind: 'task' }, input: { text: 'remind me' } },
          { expect: { weekday: 5 }, input: { text: 'Friday' } },
        ],
      },
    });
    const cases = loadCases(dir);
    expect(cases.map((benchCase) => benchCase.id)).toEqual(['a', 'b', 'c']);
    expect(cases[0]).toMatchObject({ blind: false, contacts: 'team', lang: 'en', tags: [] });
    // The first turn is an event unless the case says a to-do; later turns say nothing of the kind.
    expect(cases[0]?.turns[0]?.expect).toEqual({ kind: 'event', weekday: 5 });
    expect(cases[1]?.turns[0]?.expect.kind).toBe('event');
    expect(cases[2]?.turns.map((turn) => turn.expect)).toEqual([{ kind: 'task' }, { weekday: 5 }]);
    expect(cases[1]).toMatchObject({ contacts: 'family', locale: 'de-AT', tags: ['flow'] });
    expect(localeOf(cases[0]!)).toBe('en-US');
    expect(localeOf(cases[1]!)).toBe('de-AT');
    expect(localeOf({ ...cases[1]!, locale: undefined })).toBe('de-DE');
  });

  it('reads a blind case as one', () => {
    const cases = loadCases(
      caseDir({
        'open.json': { lang: 'en', turns: [] },
        'sealed.json': { blind: true, lang: 'en', turns: [] },
      }),
    );
    expect(cases.map((benchCase) => benchCase.blind)).toEqual([false, true]);
  });

  it('names the file that does not parse', () => {
    const dir = caseDir({
      'bad.json': { lang: 'fr', turns: [] },
      'worse.json': '{ not json',
    });
    expect(() => loadCases(dir)).toThrow(/^bad\.json: /);
    expect(() => loadCases(caseDir({ 'worse.json': '{ not json' }))).toThrow(/^worse\.json: /);
    expect(() =>
      loadCases(
        caseDir({ 'x.json': { lang: 'en', turns: [{ expect: {}, input: { audio: 'a' } }] } }),
      ),
    ).toThrow(/^x\.json: /);
    // A repeat's days are weekday codes, a monthly rule's with their place in the month.
    const repeating = (byDay: ReadonlyArray<string>) =>
      caseDir({
        'r.json': {
          lang: 'en',
          turns: [{ expect: { repeat: { byDay, freq: 'monthly' } }, input: { text: 'x' } }],
        },
      });
    expect(() => loadCases(repeating(['Friday']))).toThrow(
      /^r\.json: repeat\.byDay "Friday" is no weekday code/,
    );
    expect(() => loadCases(repeating(['6FR']))).toThrow(/^r\.json: /);
    expect(loadCases(repeating(['-1FR', '1TU', 'MO']))).toHaveLength(1);
  });

  it('holds a place meant to the text that names it', () => {
    const placed = (expectation: Record<string, unknown>) =>
      caseDir({
        'p.json': { lang: 'en', turns: [{ expect: expectation, input: { text: 'x' } }] },
      });
    expect(() => loadCases(placed({ place: ['Figlmüller'] }))).toThrow(
      /^p\.json: place needs location or locationIs beside it/,
    );
    expect(() => loadCases(placed({ location: null, place: ['Figlmüller'] }))).toThrow(
      /^p\.json: /,
    );
    expect(() => loadCases(placed({ location: 'figl', place: [] }))).toThrow(
      /^p\.json: place lists/,
    );
    expect(loadCases(placed({ location: 'figl', place: ['Figlmüller'] }))).toHaveLength(1);
    expect(loadCases(placed({ locationIs: 'figlmüller', place: ['Figlmüller'] }))).toHaveLength(1);
  });

  it('loads the repository cases', () => {
    const cases = loadCases(join(BENCH_DIR, 'cases'));
    expect(cases.length).toBeGreaterThan(0);
    // Every turn has words to parse, and every recording a transcript to hold it to.
    for (const benchCase of cases) {
      for (const turn of benchCase.turns) {
        const words = 'text' in turn.input ? turn.input.text : turn.input.transcript;
        expect(words.trim(), `${benchCase.id}`).not.toBe('');
      }
    }
  });
});

describe('filterCases', () => {
  const cases = loadCases(
    caseDir({
      'flow-dinner.json': { lang: 'en', tags: ['flow', 'guests'], turns: [] },
      'lunch.json': { lang: 'en', tags: ['basic'], turns: [] },
      'zahnarzt.json': { lang: 'de', tags: ['de'], turns: [] },
    }),
  );

  it('keeps every case without a selection, else those a term names by id part or tag', () => {
    expect(filterCases(cases, undefined)).toHaveLength(3);
    expect(filterCases(cases, ' , ')).toHaveLength(3);
    expect(filterCases(cases, 'dinner').map((benchCase) => benchCase.id)).toEqual(['flow-dinner']);
    expect(filterCases(cases, 'DE').map((benchCase) => benchCase.id)).toEqual(['zahnarzt']);
    expect(filterCases(cases, 'flow,basic').map((benchCase) => benchCase.id)).toEqual([
      'flow-dinner',
      'lunch',
    ]);
    // A tag matches whole: 'flo' is no tag, and no id holds it either.
    expect(filterCases(cases, 'gue')).toHaveLength(0);
  });

  it('leaves blind cases out of a selection, and in a run of every case', () => {
    const withBlind = loadCases(
      caseDir({
        'flow-open.json': { lang: 'en', tags: ['flow'], turns: [] },
        'flow-sealed.json': { blind: true, lang: 'en', tags: ['flow'], turns: [] },
      }),
    );
    expect(filterCases(withBlind, undefined)).toHaveLength(2);
    expect(filterCases(withBlind, 'flow').map((benchCase) => benchCase.id)).toEqual(['flow-open']);
    expect(filterCases(withBlind, 'sealed')).toHaveLength(0);
    expect(filterCases(withBlind, 'flow', { showBlind: true })).toHaveLength(2);
  });
});

describe('loadContacts', () => {
  it('makes device contacts of the books, one id per address', () => {
    const dir = caseDir({
      'contacts.json': {
        team: [
          { displayName: 'Tom Baker', email: 'tom.baker@example.com' },
          { email: 'jo@example.com' },
        ],
      },
    });
    const books = loadContacts(join(dir, 'contacts.json'));
    expect(books['team']).toEqual([
      expect.objectContaining({
        displayName: 'Tom Baker',
        email: 'tom.baker@example.com',
        id: 'device:0:tom.baker@example.com',
        source: 'device',
      }),
      expect.objectContaining({ email: 'jo@example.com', id: 'device:1:jo@example.com' }),
    ]);
    expect(books['team']?.[1]?.displayName).toBeUndefined();
  });

  it('reads the repository address book', () => {
    const books = loadContacts(join(BENCH_DIR, 'contacts.json'));
    expect(books['team']?.length).toBeGreaterThan(5);
    expect(books['team']?.every((contact) => contact.email.endsWith('@example.com'))).toBe(true);
  });
});
