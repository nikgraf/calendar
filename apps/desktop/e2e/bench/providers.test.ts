import { QUICK_ADD_JSON_SCHEMA } from '@calendar/ai';
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

describe('claudeSchema', () => {
  it('writes a nullable choice as the choice or null, and leaves the rest', () => {
    const nullableChoice = { enum: ['daily', 'weekly', null], type: ['string', 'null'] };
    // The strict schema writes the optional `freq` the way Claude refuses.
    expect(JSON.stringify(strictSchema(SCHEMA))).toContain(JSON.stringify(nullableChoice));
    const strict = claudeSchema(strictSchema(SCHEMA)) as {
      readonly properties: Record<string, unknown>;
      readonly required: ReadonlyArray<string>;
    };
    expect(JSON.stringify(strict)).not.toContain(JSON.stringify(nullableChoice));
    expect(JSON.stringify(strict)).toContain(
      JSON.stringify({ anyOf: [{ enum: ['daily', 'weekly'], type: 'string' }, { type: 'null' }] }),
    );
    expect(strict.required).toEqual(['allDay', 'date', 'kind', 'people', 'repeat', 'title']);
    expect(strict.properties['kind']).toEqual({ enum: ['event', 'task'], type: 'string' });
    expect(strict.properties['date']).toEqual({ type: ['string', 'null'] });
  });

  it('leaves no nullable choice in the schema the app asks with', () => {
    const asked = JSON.stringify(claudeSchema(strictSchema(QUICK_ADD_JSON_SCHEMA)));
    expect(JSON.stringify(strictSchema(QUICK_ADD_JSON_SCHEMA))).toContain('"yearly",null]');
    expect(asked).not.toContain('"yearly",null]');
    expect(asked).toContain(
      JSON.stringify({ enum: ['daily', 'weekly', 'monthly', 'yearly'], type: 'string' }),
    );
  });
});
