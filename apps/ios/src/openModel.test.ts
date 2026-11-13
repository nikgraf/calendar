import { describe, expect, it } from 'vite-plus/test';
import {
  MAX_ANSWER_TOKENS,
  type OpenModelCall,
  type OpenModelContext,
  openLanguageModel,
} from './openModel.ts';

const SCHEMA = {
  additionalProperties: false,
  properties: { location: { type: 'string' }, title: { type: 'string' } },
  required: ['title'],
  type: 'object',
};

type Completion = OpenModelContext['completion'];

const noop = (): void => undefined;

const contextWith = (completion: Completion): OpenModelContext => ({
  completion,
  gpu: false,
  model: { desc: 'test', nParams: 0, size: 0 },
  reasonNoGPU: '',
  release: async () => undefined,
  stopCompletion: async () => undefined,
});

describe('openLanguageModel', () => {
  it('sends the strict schema, thinking off, temperature 0 and a cap on the answer', async () => {
    const asked: Array<Record<string, unknown>> = [];
    const model = openLanguageModel(
      contextWith(async (params) => {
        asked.push(params);
        return { content: '{"location":null,"title":"Dinner"}', text: 'ignored' };
      }),
    );
    // The null a required-but-nullable field came back with is "nothing said".
    expect(await model.generateJson({ jsonSchema: SCHEMA, prompt: 'Phrase: Dinner' })).toEqual({
      title: 'Dinner',
    });
    expect(asked[0]).toEqual({
      enable_thinking: false,
      messages: [{ content: 'Phrase: Dinner', role: 'user' }],
      n_predict: MAX_ANSWER_TOKENS,
      response_format: {
        json_schema: {
          schema: {
            additionalProperties: false,
            properties: { location: { type: ['string', 'null'] }, title: { type: 'string' } },
            required: ['location', 'title'],
            type: 'object',
          },
          strict: true,
        },
        type: 'json_schema',
      },
      temperature: 0,
    });
    expect(await model.status()).toBe('ready');
  });

  it('holds nothing over the answer when it is asked with no schema', async () => {
    const asked: Array<Record<string, unknown>> = [];
    const model = openLanguageModel(
      contextWith(async (params) => {
        asked.push(params);
        return { content: '{"kind":"event","title":"Dinner"}' };
      }),
    );
    expect(await model.generateJson({ jsonSchema: undefined, prompt: 'Phrase: Dinner' })).toEqual({
      kind: 'event',
      title: 'Dinner',
    });
    expect(asked[0]).toEqual({
      enable_thinking: false,
      messages: [{ content: 'Phrase: Dinner', role: 'user' }],
      n_predict: MAX_ANSWER_TOKENS,
      temperature: 0,
    });
  });

  it('reads the object behind the empty thinking block the runtime leaves in the content', async () => {
    const model = openLanguageModel(
      contextWith(async () => ({
        content: '<think>\n\n</think>\n\n{"kind":"event","title":"Lunch"}',
      })),
    );
    expect(await model.generateJson({ jsonSchema: undefined, prompt: 'Phrase: Lunch' })).toEqual({
      kind: 'event',
      title: 'Lunch',
    });
  });

  it('reads the object out of a text that opens with the template’s assistant turn', async () => {
    const answers = [
      { content: '', text: '<|im_start|>assistant\n\n{"location":null,"title":"Dinner"}' },
      { text: '{"title":"Lunch"}' },
    ];
    const model = openLanguageModel(contextWith(async () => answers.shift() ?? {}));
    const ask = () => model.generateJson({ jsonSchema: SCHEMA, prompt: 'Phrase' });
    expect(await ask()).toEqual({ title: 'Dinner' });
    expect(await ask()).toEqual({ title: 'Lunch' });
  });

  it('gives each call’s numbers, and the reason when a call gives no answer', async () => {
    const calls: Array<OpenModelCall> = [];
    const answers = [
      {
        text: '{"title":"Dinner"}',
        // 430 prompt tokens, 30 of them read: the other 400 were kept from the call before.
        timings: { predicted_ms: 500, predicted_n: 20, prompt_ms: 100, prompt_n: 30 },
        tokens_evaluated: 430,
      },
      { text: '{"title":"Din' },
      { content: '  ' },
    ];
    const model = openLanguageModel(
      contextWith(async () => answers.shift() ?? {}),
      (call) => calls.push(call),
    );
    const ask = () => model.generateJson({ jsonSchema: SCHEMA, prompt: 'Phrase: Dinner' });
    expect(await ask()).toEqual({ title: 'Dinner' });
    // Cut off at the cap, the answer is no JSON: the caller gets the error, the count gets why.
    await expect(ask()).rejects.toThrow('The answer is not JSON (13 characters): {"title":"Din');
    await expect(ask()).rejects.toThrow('The model returned an empty response.');
    expect(calls[0]).toEqual({
      answerMs: 500,
      answerTokens: 20,
      promptMs: 100,
      promptTokens: 430,
      readTokens: 30,
    });
    expect(calls[1]?.error).toBe('The answer is not JSON (13 characters): {"title":"Din');
    expect(calls[2]).toMatchObject({
      answerTokens: 0,
      error: 'The model returned an empty response.',
    });
  });

  it('starts no call once it is cancelled, the queued ones included', async () => {
    const started: Array<string> = [];
    const calls: Array<OpenModelCall> = [];
    let cancelled = false;
    let release: () => void = noop;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = openLanguageModel(
      contextWith(async (params) => {
        const [{ content }] = params['messages'] as [{ content: string }];
        started.push(content);
        await first;
        return { text: '{"title":"x"}' };
      }),
      (call) => calls.push(call),
      () => cancelled,
    );
    // As the pipeline asks: who is invited, and beside it the extraction.
    const people = model.generateJson({ jsonSchema: SCHEMA, prompt: 'people' });
    const extraction = model.generateJson({ jsonSchema: SCHEMA, prompt: 'extraction' });
    await Promise.resolve();
    // The app leaves the screen while the first is answered.
    cancelled = true;
    release();
    await people;
    await expect(extraction).rejects.toThrow('The run was cut short.');
    await expect(model.generateJson({ jsonSchema: SCHEMA, prompt: 'later' })).rejects.toThrow(
      'The run was cut short.',
    );
    // The runtime was asked once: nothing new goes to the GPU after the cut.
    expect(started).toEqual(['people']);
    expect(calls.map((call) => call.error)).toEqual([
      undefined,
      'The run was cut short.',
      'The run was cut short.',
    ]);
  });

  it('answers one call at a time, though the pipeline asks side by side', async () => {
    const order: Array<string> = [];
    let release: () => void = noop;
    const first = new Promise<void>((resolve) => {
      release = resolve;
    });
    const model = openLanguageModel(
      contextWith(async (params) => {
        const [{ content }] = params['messages'] as [{ content: string }];
        order.push(`start ${content}`);
        if (content === 'slow') {
          await first;
        }
        order.push(`end ${content}`);
        if (content === 'broken') {
          throw new Error('context failed');
        }
        return { text: '{"title":"x"}' };
      }),
    );
    const slow = model.generateJson({ jsonSchema: SCHEMA, prompt: 'slow' });
    const broken = model.generateJson({ jsonSchema: SCHEMA, prompt: 'broken' });
    const last = model.generateJson({ jsonSchema: SCHEMA, prompt: 'last' });
    await Promise.resolve();
    expect(order).toEqual(['start slow']);
    release();
    await slow;
    // A call that fails does not hold up the one behind it.
    await expect(broken).rejects.toThrow('context failed');
    await last;
    expect(order).toEqual([
      'start slow',
      'end slow',
      'start broken',
      'end broken',
      'start last',
      'end last',
    ]);
  });
});
