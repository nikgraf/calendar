import { describe, expect, it } from 'vite-plus/test';
import { buildFindTimePrompt, FIND_TIME_JSON_SCHEMA } from './findTime.ts';
import { fixtureTextRecognizer, makeFixtureLanguageModel } from './fixtureModel.ts';
import { parseQuickAdd } from './parseQuickAdd.ts';
import { buildQuickAddPrompt, QUICK_ADD_JSON_SCHEMA } from './quickAdd.ts';
import { parseRefine } from './refine.ts';
import { buildSearchQueryPrompt, SEARCH_QUERY_JSON_SCHEMA } from './searchQuery.ts';

const CONTEXT = { referenceDate: '2026-09-20', timeZone: 'Europe/Vienna' };

describe('makeFixtureLanguageModel', () => {
  const model = makeFixtureLanguageModel();

  it('is always ready', async () => {
    await expect(model.status()).resolves.toBe('ready');
  });

  it('answers quick-add with the phrase as the title', async () => {
    const result = await parseQuickAdd(model, {
      fallbackDate: '2026-09-25',
      phrase: 'Conference call',
      ...CONTEXT,
    });
    expect(result).toMatchObject({
      kind: 'parsed',
      prefill: { date: '2026-09-25', isAllDay: true, title: 'Conference call' },
    });
  });

  it('leaves the phrase words to the normalizer, like any model', async () => {
    // The fixture says nothing about the day or time; the normalizer reads
    // "tomorrow" and "at 1" off the phrase itself.
    const result = await parseQuickAdd(model, {
      fallbackDate: '2026-09-25',
      phrase: 'Lunch with Sarah tomorrow at 1',
      ...CONTEXT,
    });
    expect(result).toMatchObject({
      kind: 'parsed',
      prefill: {
        date: '2026-09-21',
        endTime: '14:00',
        isAllDay: false,
        startTime: '13:00',
        title: 'Lunch with Sarah tomorrow at 1',
      },
    });
  });

  it('reads the grammar in a quick-add phrase', async () => {
    const result = await parseQuickAdd(model, { phrase: 'Dentist | +3 | 14:30', ...CONTEXT });
    expect(result).toMatchObject({
      kind: 'parsed',
      prefill: { date: '2026-09-23', endTime: '15:30', startTime: '14:30', title: 'Dentist' },
    });
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

  it('refuses a schema it does not know', async () => {
    const prompt = buildQuickAddPrompt({ phrase: 'x', ...CONTEXT });
    await expect(
      model.generateJson({
        jsonSchema: { properties: { mood: { type: 'string' } }, type: 'object' },
        prompt,
      }),
    ).rejects.toThrow('unsupported schema');
    await expect(
      model.generateJson({ jsonSchema: QUICK_ADD_JSON_SCHEMA, prompt: 'no date here' }),
    ).rejects.toThrow('reference date');
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

describe('makeFixtureLanguageModel refinements', () => {
  const model = makeFixtureLanguageModel();
  const draft = {
    date: '2026-09-23',
    endTime: '15:30',
    isAllDay: false,
    startTime: '14:30',
    title: 'Dentist',
  };

  it('applies the non-empty parts of the grammar to the draft in the prompt', async () => {
    expect(
      await parseRefine(model, { draft, utterance: '| | 10:00-11:00', ...CONTEXT }),
    ).toMatchObject({
      kind: 'parsed',
      prefill: { date: '2026-09-23', endTime: '11:00', startTime: '10:00', title: 'Dentist' },
    });
    expect(
      await parseRefine(model, { draft, utterance: 'Checkup | +5 | | Room 2', ...CONTEXT }),
    ).toMatchObject({
      prefill: {
        date: '2026-09-25',
        endTime: '15:30',
        location: 'Room 2',
        startTime: '14:30',
        title: 'Checkup',
      },
    });
  });

  it('leaves a sentence to the normalizer', async () => {
    // The fixture returns the draft as it is; the normalizer reads "at 4pm".
    expect(await parseRefine(model, { draft, utterance: 'at 4pm', ...CONTEXT })).toMatchObject({
      prefill: { endTime: '17:00', startTime: '16:00', title: 'Dentist' },
    });
  });
});

describe('makeFixtureLanguageModel tasks', () => {
  it('reads "todo:" as a task, with the grammar after it', async () => {
    // The marker is a to-do cue for the normalizer; the fixture only keeps
    // it out of the title.
    const model = makeFixtureLanguageModel();
    const plain = await parseQuickAdd(model, {
      fallbackDate: '2026-09-25',
      phrase: 'todo: Buy milk',
      ...CONTEXT,
    });
    expect(plain).toEqual({ kind: 'task', prefill: { date: '2026-09-25', title: 'Buy milk' } });
    const timed = await parseQuickAdd(model, {
      phrase: 'todo: Call bank | +1 | 09:30',
      ...CONTEXT,
    });
    expect(timed).toEqual({
      kind: 'task',
      prefill: { date: '2026-09-21', time: '09:30', title: 'Call bank' },
    });
  });
});
