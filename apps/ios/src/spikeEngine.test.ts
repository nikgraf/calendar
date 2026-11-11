import type { LanguageModel } from '@calendar/ai';
import { describe, expect, it } from 'vite-plus/test';
import type { OpenModelCall } from './openModel.ts';
import { systemEngine } from './spikeEngine.ts';

const clock = () => {
  let time = 0;
  return () => {
    time += 700;
    return time;
  };
};

describe('systemEngine', () => {
  it('asks the model as it is and gives each call its time, with no tokens', async () => {
    const asked: Array<unknown> = [];
    const apple: LanguageModel = {
      generateJson: async (request) => {
        asked.push(request);
        return { title: 'Dinner' };
      },
      status: async () => 'ready',
    };
    const calls: Array<OpenModelCall> = [];
    const model = systemEngine(apple, clock()).modelFor(
      (call) => calls.push(call),
      () => false,
    );
    const request = { jsonSchema: { type: 'object' }, prompt: 'Phrase: Dinner' };
    expect(await model.generateJson(request)).toEqual({ title: 'Dinner' });
    // The schema goes over untouched: the app's own request is the thing measured.
    expect(asked).toEqual([request]);
    expect(calls).toEqual([
      { answerMs: 700, answerTokens: 0, promptMs: 0, promptTokens: 0, readTokens: 0 },
    ]);
    expect(await model.status()).toBe('ready');
  });

  it('starts no call once the run is cut short, and says why a call gave no answer', async () => {
    let cut = false;
    let asked = 0;
    const apple: LanguageModel = {
      generateJson: async () => {
        asked += 1;
        throw new Error('Generation timed out.');
      },
      status: async () => 'ready',
    };
    const calls: Array<OpenModelCall> = [];
    const engine = systemEngine(apple, clock());
    const model = engine.modelFor(
      (call) => calls.push(call),
      () => cut,
    );
    const request = { jsonSchema: {}, prompt: 'Phrase' };
    await expect(model.generateJson(request)).rejects.toThrow('Generation timed out.');
    cut = true;
    await expect(model.generateJson(request)).rejects.toThrow('The run was cut short.');
    expect(asked).toBe(1);
    expect(calls.map((call) => call.error)).toEqual([
      'Generation timed out.',
      'The run was cut short.',
    ]);
    // Nothing of it is the app's to stop or to free.
    expect(engine.stop()).toBeUndefined();
    await engine.release();
    expect(engine.gpu).toBeUndefined();
  });
});
