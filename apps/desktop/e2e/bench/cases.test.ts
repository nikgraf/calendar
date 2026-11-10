import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { filterCases, loadCases, loadContacts, loadPlaces, localeOf, placeKey } from './cases.ts';

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
    expect(cases[0]).toMatchObject({ contacts: 'team', lang: 'en', tags: [] });
    // The first turn is an event unless the case says a to-do; later turns say nothing of the kind.
    expect(cases[0]?.turns[0]?.expect).toEqual({ kind: 'event', weekday: 5 });
    expect(cases[1]?.turns[0]?.expect.kind).toBe('event');
    expect(cases[2]?.turns.map((turn) => turn.expect)).toEqual([{ kind: 'task' }, { weekday: 5 }]);
    expect(cases[1]).toMatchObject({ contacts: 'family', locale: 'de-AT', tags: ['flow'] });
    expect(localeOf(cases[0]!)).toBe('en-US');
    expect(localeOf(cases[1]!)).toBe('de-AT');
    expect(localeOf({ ...cases[1]!, locale: undefined })).toBe('de-DE');
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

describe('loadPlaces', () => {
  it('reads the town: past places the latest last, a search’s hits by the name folded', () => {
    const dir = caseDir({
      'places.json': {
        found: { 'Luigi’s': [{ lat: 48.2, lng: 16.37, name: "Luigi's" }] },
        past: [
          { lat: 48.21, lng: 16.36, source: 'Mercato' },
          { lat: 48.2, lng: 16.35, name: 'Kaffemik', source: 'Kaffemik, Zollergasse 5' },
        ],
      },
    });
    const town = loadPlaces(join(dir, 'places.json'), 'Europe/Vienna');
    expect(town.found[placeKey("LUIGI'S")]).toEqual([{ lat: 48.2, lng: 16.37, name: "Luigi's" }]);
    expect(town.past.map((place) => [place.geo.source, place.geo.name, place.lastUsedUtc])).toEqual(
      [
        ['Mercato', undefined, 0],
        ['Kaffemik, Zollergasse 5', 'Kaffemik', 1],
      ],
    );
    expect(town.region).toMatchObject({ lat: 48.2082, lng: 16.3738 });
    // A zone the table does not know: nothing is close, so no hit is proof.
    expect(loadPlaces(join(dir, 'places.json'), 'Etc/UTC').region).toBeUndefined();
  });

  it('reads the repository town, and every search a case could ask it', () => {
    const town = loadPlaces(join(BENCH_DIR, 'places.json'), 'Europe/Vienna');
    expect(town.found[placeKey('Figlmüller')]?.map((hit) => hit.name)).toContain('Figlmüller');
    expect(town.past.map((place) => place.geo.source)).toContain('Mercato');
  });
});
