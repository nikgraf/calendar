import { describe, expect, it } from 'vite-plus/test';
import { strictSchema } from '../../electron/strictSchema.ts';
import {
  claudeSchema,
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
    date: { type: 'string' },
    kind: { enum: ['event', 'task'], type: 'string' },
    people: { items: { type: 'string' }, type: 'array' },
    repeat: {
      additionalProperties: false,
      properties: {
        count: { type: 'number' },
        freq: { enum: ['daily', 'weekly'], type: 'string' },
      },
      required: ['freq'],
      type: 'object',
    },
    title: { type: 'string' },
  },
  required: ['kind', 'title'],
  type: 'object',
} as const;

describe('requiredSchema', () => {
  it('requires every property, and gives a choice that was optional a "none"', () => {
    expect(requiredSchema(SCHEMA)).toEqual({
      ...SCHEMA,
      properties: {
        ...SCHEMA.properties,
        repeat: {
          ...SCHEMA.properties.repeat,
          // Required inside an optional object: still a choice the words may not make.
          properties: {
            count: { type: 'number' },
            freq: { enum: ['daily', 'weekly', 'none'], type: 'string' },
          },
          required: ['count', 'freq'],
        },
      },
      required: ['date', 'kind', 'people', 'repeat', 'title'],
    });
  });

  it('reads the empty values back as nothing said', async () => {
    expect(
      withoutEmpties({
        date: ' ',
        kind: 'event',
        people: [],
        reminders: [0, 10],
        repeat: { count: 0, freq: 'none' },
        title: 'Dinner',
      }),
    ).toEqual({ kind: 'event', people: [], reminders: [0, 10], title: 'Dinner' });
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
});

describe('claudeSchema', () => {
  it('writes a nullable choice as the choice or null, and leaves the rest', () => {
    const strict = claudeSchema(strictSchema(SCHEMA)) as {
      readonly properties: Record<string, unknown>;
      readonly required: ReadonlyArray<string>;
    };
    expect(strict.required).toEqual(['date', 'kind', 'people', 'repeat', 'title']);
    expect(strict.properties['kind']).toEqual({ enum: ['event', 'task'], type: 'string' });
    expect(strict.properties['date']).toEqual({ type: ['string', 'null'] });
    expect(JSON.stringify(strict)).not.toContain('"enum":["daily","weekly",null]');
    expect(claudeSchema({ enum: ['daily', 'weekly', null], type: ['string', 'null'] })).toEqual({
      anyOf: [{ enum: ['daily', 'weekly'], type: 'string' }, { type: 'null' }],
    });
  });
});
