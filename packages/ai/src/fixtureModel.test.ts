import { describe, expect, it } from 'vitest';
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
