import { QUICK_ADD_JSON_SCHEMA } from '@calendar/ai';
import { describe, expect, it } from 'vite-plus/test';
import { strictSchema } from '../../electron/strictSchema.ts';
import {
  openAiExtra,
  openAiJsonMode,
  openAiRequest,
  recording,
  requiredSchema,
  requiringEveryField,
  withoutEmpties,
} from './providers.ts';

const noop = (): void => undefined;

describe('recording', () => {
  it('lands a call in the turn it started in, however late it finishes', async () => {
    let release: (value: unknown) => void = noop;
    const slow = new Promise((resolve) => {
      release = resolve;
    });
    const model = recording({
      generateJson: async ({ prompt }) => (prompt === 'slow' ? slow : { fast: true }),
      status: async () => 'ready',
    });
    const first = model.begin();
    const late = model.model.generateJson({ jsonSchema: {}, prompt: 'slow' });
    await model.model.generateJson({ jsonSchema: {}, prompt: 'fast' });
    const second = model.begin();
    await model.model.generateJson({ jsonSchema: {}, prompt: 'fast' });
    release({ slow: true });
    await late;
    expect(first.map((call) => call.prompt)).toEqual(['fast', 'slow']);
    expect(first[1]?.answer).toEqual({ slow: true });
    expect(second.map((call) => call.prompt)).toEqual(['fast']);
  });

  it('records a failed call with its error and rethrows', async () => {
    const model = recording({
      generateJson: async () => {
        throw new Error('generation failed');
      },
      status: async () => 'ready',
    });
    const calls = model.begin();
    await expect(model.model.generateJson({ jsonSchema: {}, prompt: 'x' })).rejects.toThrow(
      'generation failed',
    );
    expect(calls).toEqual([
      expect.objectContaining({ answer: undefined, error: 'generation failed', prompt: 'x' }),
    ]);
    // The rest of the seam passes through.
    expect(await model.model.status()).toBe('ready');
  });
});

const SCHEMA = {
  additionalProperties: false,
  properties: {
    allDay: { type: 'boolean' },
    date: { type: 'string' },
    kind: { enum: ['event', 'task'], type: 'string' },
    people: { items: { type: 'string' }, type: 'array' },
    repeat: {
      additionalProperties: false,
      properties: {
        count: { type: 'number' },
        freq: { enum: ['daily', 'weekly'], type: 'string' },
      },
      type: 'object',
    },
    title: { type: 'string' },
  },
  required: ['kind', 'title'],
  type: 'object',
} as const;

describe('requiredSchema', () => {
  it('requires every property but a yes-or-no one, and gives an optional choice a "none"', () => {
    expect(requiredSchema(SCHEMA)).toEqual({
      ...SCHEMA,
      properties: {
        ...SCHEMA.properties,
        repeat: {
          ...SCHEMA.properties.repeat,
          properties: {
            count: { type: 'number' },
            freq: { enum: ['daily', 'weekly', 'none'], type: 'string' },
          },
          required: ['count', 'freq'],
        },
      },
      // `allDay` has no empty value to write: it stays optional.
      required: ['date', 'kind', 'people', 'repeat', 'title'],
    });
    // A yes-or-no the schema itself requires stays required.
    expect(
      requiredSchema({
        properties: { done: { type: 'boolean' }, note: { type: 'string' } },
        required: ['done'],
        type: 'object',
      }),
    ).toMatchObject({ required: ['done', 'note'] });
  });

  it('reads the empty values back as nothing said, inside a list of texts too', async () => {
    expect(
      withoutEmpties({
        allDay: false,
        date: ' ',
        kind: 'event',
        people: ['', 'none', 'Ben', ' None '],
        reminders: [0, 10],
        repeat: { count: 0, freq: 'none' },
        title: 'Dinner',
        uninvite: ['none'],
      }),
    ).toEqual({
      allDay: false,
      kind: 'event',
      people: ['Ben'],
      // A notification at the start is a real 0.
      reminders: [0, 10],
      title: 'Dinner',
      uninvite: [],
    });
    const asked: Array<{ jsonSchema: unknown; prompt: string }> = [];
    const model = requiringEveryField({
      generateJson: async (request) => {
        asked.push(request);
        return { date: '', kind: 'event', title: 'Dinner' };
      },
      status: async () => 'ready',
    });
    expect(await model.generateJson({ jsonSchema: SCHEMA, prompt: 'Phrase: Dinner' })).toEqual({
      kind: 'event',
      title: 'Dinner',
    });
    expect(asked[0]?.jsonSchema).toEqual(requiredSchema(SCHEMA));
    expect(asked[0]?.prompt).toMatch(/^Every field must be in the answer\..*\nPhrase: Dinner$/su);
  });

  it('is recorded as sent and as answered when it sits around the recorder', async () => {
    const recorded = recording({
      generateJson: async () => ({ date: '', kind: 'event', people: ['none'], title: 'Dinner' }),
      status: async () => 'ready',
    });
    const calls = recorded.begin();
    const model = requiringEveryField(recorded.model);
    expect(await model.generateJson({ jsonSchema: SCHEMA, prompt: 'Phrase: Dinner' })).toEqual({
      kind: 'event',
      people: [],
      title: 'Dinner',
    });
    expect(calls[0]?.prompt).toMatch(/^Every field must be in the answer/u);
    expect(calls[0]?.answer).toEqual({
      date: '',
      kind: 'event',
      people: ['none'],
      title: 'Dinner',
    });
  });
});

describe('openAiExtra', () => {
  it('is the object the variable holds, and nothing when it is unset', () => {
    expect(openAiExtra(undefined)).toEqual({});
    expect(openAiExtra('  ')).toEqual({});
    expect(openAiExtra('{"reasoning_effort":"none","temperature":0.2}')).toEqual({
      reasoning_effort: 'none',
      temperature: 0.2,
    });
  });

  it('refuses what is no JSON object, and what would replace the request the bench makes', () => {
    expect(() => openAiExtra('think')).toThrow('MODEL_BENCH_OPENAI_EXTRA is not JSON');
    expect(() => openAiExtra('[1]')).toThrow('MODEL_BENCH_OPENAI_EXTRA must be a JSON object');
    // The strict schema gone, under a report that says it was sent.
    expect(() =>
      openAiExtra('{"response_format":{"type":"json_object"},"model":"another"}'),
    ).toThrow('MODEL_BENCH_OPENAI_EXTRA may not set model, response_format');
  });
});

describe('openAiRequest', () => {
  const asked = { extra: { reasoning_effort: 'none' }, model: 'served', prompt: 'Lunch at 1' };

  it('holds the strict schema over the answer, and joins the extra', () => {
    const request = openAiRequest({ ...asked, jsonSchema: QUICK_ADD_JSON_SCHEMA });
    expect(request).toMatchObject({
      messages: [{ content: 'Lunch at 1', role: 'user' }],
      model: 'served',
      reasoning_effort: 'none',
      response_format: {
        json_schema: { schema: strictSchema(QUICK_ADD_JSON_SCHEMA), strict: true },
        type: 'json_schema',
      },
      temperature: 0,
    });
  });

  it('holds nothing over the answer of a caller that asks with no schema', () => {
    const request = openAiRequest({ ...asked, jsonSchema: undefined });
    expect(Object.keys(request).toSorted()).toEqual([
      'messages',
      'model',
      'reasoning_effort',
      'temperature',
    ]);
  });

  it('asks a JSON-mode server for JSON, with the schema in the question', () => {
    const request = openAiRequest({
      ...asked,
      jsonMode: 'object',
      jsonSchema: QUICK_ADD_JSON_SCHEMA,
    });
    expect(request['response_format']).toEqual({ type: 'json_object' });
    const [message] = request['messages'] as ReadonlyArray<{ readonly content: string }>;
    expect(message?.content.startsWith('Lunch at 1\n\nAnswer with one JSON object')).toBe(true);
    expect(message?.content.endsWith(JSON.stringify(QUICK_ADD_JSON_SCHEMA))).toBe(true);
  });

  it('reads the mode from its variable: object, or the strict default', () => {
    expect(openAiJsonMode('object')).toBe('object');
    expect(openAiJsonMode(' object ')).toBe('object');
    expect(openAiJsonMode(undefined)).toBe('schema');
    expect(openAiJsonMode('json_schema')).toBe('schema');
  });
});
