import type { SearchQuery } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import { ModelUnavailableError, type LanguageModel, type ModelStatus } from './model.ts';
import {
  buildSearchQueryPrompt,
  normalizeSearchQuery,
  parseSearchQuery,
  type SearchQueryParse,
} from './searchQuery.ts';

const TODAY = '2026-10-14';
const calendars = [
  { key: 'acc:work', name: 'Work' },
  { key: 'acc:family', name: 'Family' },
  { key: 'acc:projects', name: 'Work Projects' },
];
const lists = [{ key: 'acc:groceries', name: 'Groceries' }];

const normalize = (parse: SearchQueryParse, phrase: string, current: SearchQuery = { terms: [] }) =>
  normalizeSearchQuery(parse, { calendars, current, lists, phrase, referenceDate: TODAY });

const query = (result: ReturnType<typeof normalize>) => {
  if (result.kind !== 'parsed') {
    throw new Error(result.reason);
  }
  return result.query;
};

describe('normalizeSearchQuery — when', () => {
  it('takes the days the code reads over the model’s', () => {
    expect(query(normalize({ from: '2020-01-01', terms: ['lunch'] }, 'lunch last month'))).toEqual({
      from: '2026-09-01',
      terms: ['lunch'],
      to: '2026-09-30',
    });
  });

  it('takes the model’s days when the words say when in a form the code leaves to it', () => {
    expect(
      query(
        normalize({ from: '2026-03-01', terms: ['lunch'], to: '2026-10-14' }, 'lunch since March'),
      ),
    ).toMatchObject({ from: '2026-03-01', to: '2026-10-14' });
  });

  it('keeps the days as they were when the words say nothing about when', () => {
    const current = { from: '2026-10-01', terms: ['harbour'], to: '2026-10-31' };
    expect(
      query(
        normalize(
          { from: '2026-01-01', people: ['Anna'], terms: ['harbour'] },
          'with Anna',
          current,
        ),
      ),
    ).toEqual({ ...current, people: ['Anna'] });
  });

  it('swaps a backwards range, holds it to the search window, refuses one outside it', () => {
    expect(
      query(
        normalize({ from: '2026-10-20', terms: [], to: '2026-10-10' }, 'between 10/10 and 20/10'),
      ),
    ).toMatchObject({ from: '2026-10-10', to: '2026-10-20' });
    expect(
      query(normalize({ from: '2020-01-01', terms: [], to: '2026-10-14' }, 'since 2020-01-01')),
    ).toMatchObject({ from: '2024-10-14', to: '2026-10-14' });
    expect(
      normalize(
        { from: '2030-01-01', terms: [], to: '2030-02-01' },
        'events 2030-01-01 to 2030-02-01',
      ),
    ).toEqual({ kind: 'rejected', reason: 'Search covers two years either side of today.' });
  });

  it('drops the days on "any time"', () => {
    expect(
      query(normalize({ terms: ['a'] }, 'any time', { from: '2026-10-01', terms: ['a'] })),
    ).toEqual({ terms: ['a'] });
  });
});

describe('normalizeSearchQuery — what and where', () => {
  it('reads the kind and all-day from the words alone', () => {
    expect(query(normalize({ kind: 'task', terms: ['harbour'] }, 'harbour')).kind).toBeUndefined();
    expect(query(normalize({ terms: [] }, 'only tasks')).kind).toBe('task');
    expect(
      query(normalize({ terms: [] }, 'everything', { kind: 'event', terms: [] })).kind,
    ).toBeUndefined();
    expect(query(normalize({ allDay: true, terms: [] }, 'harbour')).allDay).toBeUndefined();
    expect(query(normalize({ terms: [] }, 'all-day')).allDay).toBe(true);
  });

  it('takes a place and people only when they are in the words', () => {
    expect(
      query(normalize({ location: 'Vienna', terms: ['lunch'] }, 'lunch in Vienna')).location,
    ).toBe('Vienna');
    expect(
      query(normalize({ location: 'Graz', terms: ['lunch'] }, 'lunch in Vienna')).location,
    ).toBeUndefined();
    const october = query(normalize({ location: 'October', terms: ['lunch'] }, 'lunch in October'));
    expect(october.location).toBeUndefined();
    expect(october.from).toBe('2026-10-01');
    expect(
      query(normalize({ location: 'unknown', terms: [] }, 'in unknown places')).location,
    ).toBeUndefined();
    expect(query(normalize({ people: ['Anna', 'Bob'], terms: [] }, 'with Anna')).people).toEqual([
      'Anna',
    ]);
  });

  it('names calendars and lists by what the words name: exact, else one by its start', () => {
    expect(query(normalize({ calendars: ['Work'], terms: [] }, 'work meetings')).calendars).toEqual(
      ['acc:work'],
    );
    expect(
      query(normalize({ calendars: ['Work'], terms: ['harbour'] }, 'harbour')).calendars,
    ).toBeUndefined();
    expect(query(normalize({ calendars: ['Fam'], terms: [] }, 'fam events')).calendars).toEqual([
      'acc:family',
    ]);
    expect(query(normalize({ calendars: ['Wo'], terms: [] }, 'wo')).calendars).toBeUndefined();
    expect(query(normalize({ lists: ['Groceries'], terms: [] }, 'groceries list')).lists).toEqual([
      'acc:groceries',
    ]);
  });

  it('keeps words typed now or before, and the ones before when none are left', () => {
    expect(query(normalize({ terms: ['lunch', 'salad'] }, 'lunch last week')).terms).toEqual([
      'lunch',
    ]);
    expect(query(normalize({ terms: [] }, 'last week', { terms: ['harbour'] })).terms).toEqual([
      'harbour',
    ]);
    expect(
      query(normalize({ terms: ['harbour'] }, 'last week', { terms: ['harbour'] })).terms,
    ).toEqual(['harbour']);
  });
});

const fakeModel = (
  answer: unknown,
  { status = 'ready' }: { status?: ModelStatus } = {},
): LanguageModel & { prompts: Array<string> } => {
  const prompts: Array<string> = [];
  return {
    generateJson: async ({ prompt }) => {
      prompts.push(prompt);
      if (answer instanceof Error) {
        throw answer;
      }
      return answer;
    },
    prompts,
    status: async () => status,
  };
};

const input = (phrase: string, current: SearchQuery = { terms: [] }) => ({
  calendars,
  current,
  lists,
  phrase,
  referenceDate: TODAY,
  timeZone: 'Europe/Vienna',
});

describe('parseSearchQuery', () => {
  it('sends the day list, the months, the names and the current filters by name', async () => {
    const model = fakeModel({ terms: ['lunch'] });
    await parseSearchQuery(
      model,
      input('lunch last week', { calendars: ['acc:work'], terms: ['x'] }),
    );
    const prompt = model.prompts[0] ?? '';
    expect(prompt).toContain('Today is 2026-10-14 in time zone Europe/Vienna.');
    expect(prompt).toContain('Wed 2026-10-14 (today)');
    expect(prompt).toContain('This month is 2026-10-01 – 2026-10-31');
    expect(prompt).toContain('Calendars: Work, Family, Work Projects.');
    expect(prompt).toContain('Lists: Groceries.');
    expect(prompt).toContain('Current filters: {"calendars":["Work"],"terms":["x"]}');
    expect(prompt.endsWith('Search: lunch last week')).toBe(true);
  });

  it('refuses a blank sentence, an unreadable answer and a failed call; throws when no model is ready', async () => {
    expect(await parseSearchQuery(fakeModel({ terms: [] }), input('  '))).toMatchObject({
      kind: 'rejected',
    });
    expect(await parseSearchQuery(fakeModel('nope'), input('harbour'))).toMatchObject({
      kind: 'rejected',
    });
    expect(await parseSearchQuery(fakeModel(new Error('boom')), input('harbour'))).toMatchObject({
      kind: 'rejected',
    });
    await expect(
      parseSearchQuery(fakeModel({ terms: [] }, { status: 'unavailable' }), input('harbour')),
    ).rejects.toBeInstanceOf(ModelUnavailableError);
  });

  it('builds the prompt the fixture model reads', () => {
    expect(buildSearchQueryPrompt(input('x'))).toContain('Search: x');
  });
});
