import { describe, expect, it } from 'vite-plus/test';
import { buildFindTimePrompt, FIND_TIME_JSON_SCHEMA } from './findTime.ts';
import { fixtureTextRecognizer, makeFixtureLanguageModel } from './fixtureModel.ts';
import { buildSearchQueryPrompt, SEARCH_QUERY_JSON_SCHEMA } from './searchQuery.ts';

const CONTEXT = { referenceDate: '2026-09-20', timeZone: 'Europe/Vienna' };

describe('makeFixtureLanguageModel', () => {
  const model = makeFixtureLanguageModel();

  it('is always ready', async () => {
    await expect(model.status()).resolves.toBe('ready');
  });

  it('answers a finder sentence with the title after the bar and an hour', async () => {
    await expect(
      model.generateJson({
        jsonSchema: FIND_TIME_JSON_SCHEMA,
        prompt: buildFindTimePrompt({ phrase: 'find 30 min tomorrow morning | Focus', ...CONTEXT }),
      }),
    ).resolves.toEqual({ durationMinutes: 60, title: 'Focus' });
    await expect(
      model.generateJson({
        jsonSchema: FIND_TIME_JSON_SCHEMA,
        prompt: buildFindTimePrompt({ phrase: 'find a slot tomorrow', ...CONTEXT }),
      }),
    ).resolves.toEqual({ durationMinutes: 60 });
  });

  /** A search turn put to the fixture as the app puts it. */
  const ask = (phrase: string, current: object = { terms: [] }) =>
    model.generateJson({
      jsonSchema: SEARCH_QUERY_JSON_SCHEMA,
      prompt: buildSearchQueryPrompt({
        calendars: [],
        current: current as never,
        lists: [],
        phrase,
        ...CONTEXT,
      }),
    });

  it('answers a search turn in its grammar, applied to the current filters', async () => {
    await expect(ask('harbour | -15..-5')).resolves.toEqual({
      from: '2026-09-05',
      terms: ['harbour'],
      to: '2026-09-15',
    });
    await expect(
      ask('| | hafen | anna, bob | Work | tasks', { terms: ['harbour'] }),
    ).resolves.toEqual({
      calendars: ['Work'],
      kind: 'task',
      location: 'hafen',
      people: ['anna', 'bob'],
      terms: ['harbour'],
    });
    await expect(ask('lunch salad', { location: 'Wien', terms: ['x'] })).resolves.toEqual({
      location: 'Wien',
      terms: ['lunch', 'salad'],
    });
  });
});

describe('fixtureTextRecognizer', () => {
  it('decodes UTF-8 bytes', async () => {
    const base64 = btoa(String.fromCharCode(...new TextEncoder().encode('Figlmüller 19:00')));
    await expect(fixtureTextRecognizer.recognizeText({ base64, kind: 'base64' })).resolves.toBe(
      'Figlmüller 19:00',
    );
  });

  it('reads base64 only', async () => {
    await expect(
      fixtureTextRecognizer.recognizeText({ kind: 'uri', uri: 'file:///x' }),
    ).rejects.toMatchObject({ _tag: 'TextRecognitionError' });
  });
});
