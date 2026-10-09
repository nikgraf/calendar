import { describe, expect, it } from 'vite-plus/test';
import { FIND_TIME_JSON_SCHEMA } from './findTime.ts';
import { fixtureTextRecognizer, makeFixtureLanguageModel } from './fixtureModel.ts';
import { parseQuickAdd } from './parseQuickAdd.ts';
import { buildQuickAddPrompt, QUICK_ADD_JSON_SCHEMA } from './quickAdd.ts';

const CONTEXT = { referenceDate: '2026-09-20', timeZone: 'Europe/Vienna' };

describe('makeFixtureLanguageModel', () => {
  const model = makeFixtureLanguageModel();

  it('is always ready', async () => {
    await expect(model.status()).resolves.toBe('ready');
  });

  it('answers quick-add with the phrase as the title', async () => {
    const result = await parseQuickAdd(model, {
      fallbackDate: '2026-09-25',
      phrase: 'Lunch with Sarah tomorrow at 1',
      ...CONTEXT,
    });
    expect(result).toMatchObject({
      kind: 'parsed',
      prefill: { date: '2026-09-25', isAllDay: true, title: 'Lunch with Sarah tomorrow at 1' },
    });
  });

  it('reads the grammar in a quick-add phrase', async () => {
    const result = await parseQuickAdd(model, { phrase: 'Dentist | +3 | 14:30', ...CONTEXT });
    expect(result).toMatchObject({
      kind: 'parsed',
      prefill: { date: '2026-09-23', endTime: '15:30', startTime: '14:30', title: 'Dentist' },
    });
  });

  it('refuses a schema it does not know', async () => {
    const prompt = buildQuickAddPrompt({ phrase: 'x', ...CONTEXT });
    await expect(model.generateJson({ jsonSchema: FIND_TIME_JSON_SCHEMA, prompt })).rejects.toThrow(
      'unsupported schema',
    );
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

describe('makeFixtureLanguageModel tasks', () => {
  it('reads "todo:" as a task, with the grammar after it', async () => {
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
