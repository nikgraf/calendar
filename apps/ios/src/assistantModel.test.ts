import { afterEach, describe, expect, it } from 'vite-plus/test';
import type { AssistantModelState } from './assistantDownload.ts';
import { createAssistantModel } from './assistantModel.ts';
import { letGoLlama, llamaHolder, takeLlama } from './llamaOwner.ts';
import type { OpenModelContext, OpenModelRuntime } from './openModel.ts';

const READY: AssistantModelState = { kind: 'ready', path: 'file:///caches/assistant.gguf' };

const fakeRuntime = () => {
  const log: Array<string> = [];
  let open = 0;
  let maxOpen = 0;
  const context: OpenModelContext = {
    completion: async () => {
      open += 1;
      maxOpen = Math.max(maxOpen, open);
      await new Promise((resolve) => setTimeout(resolve, 5));
      open -= 1;
      log.push('answer');
      return { content: '{"kind":"event","title":"Lunch"}' };
    },
    gpu: true,
    model: { desc: 'fake', nParams: 1, size: 1 },
    reasonNoGPU: '',
    release: async () => {
      log.push('release');
    },
    stopCompletion: () => {
      log.push('stop');
      return undefined;
    },
  };
  const runtime: OpenModelRuntime = {
    initLlama: async (params) => {
      log.push(`load ${String(params['model'])}`);
      return context;
    },
  };
  return { log, maxOpen: () => maxOpen, runtime };
};

afterEach(() => {
  letGoLlama('assistant');
  letGoLlama('spike');
});

describe('the Assistant’s model', () => {
  it('loads the checked file on the first question, once, and answers one at a time', async () => {
    const { log, maxOpen, runtime } = fakeRuntime();
    const model = createAssistantModel({ runtime, state: () => READY });
    await expect(model.status()).resolves.toBe('ready');
    const answers = await Promise.all([
      model.generateJson({ jsonSchema: undefined, prompt: 'a' }),
      model.generateJson({ jsonSchema: undefined, prompt: 'b' }),
    ]);
    expect(answers).toEqual([
      { kind: 'event', title: 'Lunch' },
      { kind: 'event', title: 'Lunch' },
    ]);
    expect(log.filter((line) => line.startsWith('load'))).toEqual([
      'load file:///caches/assistant.gguf',
    ]);
    expect(maxOpen()).toBe(1);
    expect(llamaHolder()).toBe('assistant');
  });

  it('lets the context go when the app leaves the screen, and loads it again for the next question', async () => {
    const { log, runtime } = fakeRuntime();
    const model = createAssistantModel({ runtime, state: () => READY });
    await model.generateJson({ jsonSchema: undefined, prompt: 'a' });
    await model.leave();
    expect(log).toContain('release');
    expect(llamaHolder()).toBeUndefined();
    await model.generateJson({ jsonSchema: undefined, prompt: 'b' });
    expect(log.filter((line) => line.startsWith('load'))).toHaveLength(2);
  });

  it('keeps the context through a memory warning while it answers', async () => {
    const { log, runtime } = fakeRuntime();
    const model = createAssistantModel({ runtime, state: () => READY });
    const answering = model.generateJson({ jsonSchema: undefined, prompt: 'a' });
    await new Promise((resolve) => setTimeout(resolve, 1));
    await model.relieve();
    await answering;
    expect(log).not.toContain('release');
    await model.relieve();
    expect(log).toContain('release');
  });

  it('answers nothing before the file is ready, and gives way to a measurement', async () => {
    const { runtime } = fakeRuntime();
    const downloading: AssistantModelState = { kind: 'downloading', received: 1, total: 2 };
    const waiting = createAssistantModel({ runtime, state: () => downloading });
    await expect(waiting.status()).resolves.toBe('not-ready');
    await expect(waiting.generateJson({ jsonSchema: undefined, prompt: 'a' })).rejects.toThrow();
    const model = createAssistantModel({ runtime, state: () => READY });
    // A measurement under way keeps the runtime.
    await takeLlama('spike', async () => false);
    await expect(model.generateJson({ jsonSchema: undefined, prompt: 'a' })).rejects.toThrow(
      'Model Spike',
    );
    // A model that only sits loaded there is let go of.
    letGoLlama('spike');
    let unloaded = false;
    await takeLlama('spike', async () => {
      unloaded = true;
      return true;
    });
    await expect(model.generateJson({ jsonSchema: undefined, prompt: 'a' })).resolves.toEqual({
      kind: 'event',
      title: 'Lunch',
    });
    expect(unloaded).toBe(true);
    expect(llamaHolder()).toBe('assistant');
    const unsupported = createAssistantModel({
      runtime,
      state: () => ({ kind: 'unsupported', reason: 'memory' }),
    });
    letGoLlama('spike');
    await expect(unsupported.status()).resolves.toBe('unsupported');
  });

  it('tries a load that failed again with the next question', async () => {
    const { runtime } = fakeRuntime();
    let fail = true;
    const flaky = {
      initLlama: async (params: Record<string, unknown>) => {
        if (fail) {
          fail = false;
          throw new Error('load failed');
        }
        return runtime.initLlama(params);
      },
    };
    const model = createAssistantModel({ runtime: flaky, state: () => READY });
    await expect(model.generateJson({ jsonSchema: undefined, prompt: 'a' })).rejects.toThrow(
      'load failed',
    );
    await expect(model.generateJson({ jsonSchema: undefined, prompt: 'b' })).resolves.toEqual({
      kind: 'event',
      title: 'Lunch',
    });
  });

  it('keeps a load under way through a memory warning', async () => {
    const { log, runtime } = fakeRuntime();
    const slow = {
      initLlama: async (params: Record<string, unknown>) => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return runtime.initLlama(params);
      },
    };
    const model = createAssistantModel({ runtime: slow, state: () => READY });
    const answering = model.generateJson({ jsonSchema: undefined, prompt: 'a' });
    await model.relieve();
    await expect(answering).resolves.toEqual({ kind: 'event', title: 'Lunch' });
    expect(log).not.toContain('release');
  });

  it('answers no question that arrives behind the screen, and loads nothing for it', async () => {
    const { log, runtime } = fakeRuntime();
    let front = true;
    const model = createAssistantModel({ foreground: () => front, runtime, state: () => READY });
    await model.generateJson({ jsonSchema: undefined, prompt: 'a' });
    front = false;
    await model.leave();
    // A dictation that ended after the app left hands its words over then.
    await expect(model.generateJson({ jsonSchema: undefined, prompt: 'b' })).rejects.toThrow(
      'left the screen',
    );
    expect(log.filter((line) => line.startsWith('load'))).toHaveLength(1);
    front = true;
    await expect(model.generateJson({ jsonSchema: undefined, prompt: 'c' })).resolves.toEqual({
      kind: 'event',
      title: 'Lunch',
    });
    expect(log.filter((line) => line.startsWith('load'))).toHaveLength(2);
  });

  it('answers no question asked before the app left the screen, and loads nothing for it', async () => {
    const { log, runtime } = fakeRuntime();
    const model = createAssistantModel({ runtime, state: () => READY });
    const first = model.generateJson({ jsonSchema: undefined, prompt: 'a' });
    const second = model.generateJson({ jsonSchema: undefined, prompt: 'b' });
    await new Promise((resolve) => setTimeout(resolve, 1));
    await model.leave();
    await Promise.allSettled([first, second]);
    await expect(second).rejects.toThrow('left the screen');
    expect(log.filter((line) => line.startsWith('load'))).toHaveLength(1);
    // The next question in front loads afresh and is answered.
    await expect(model.generateJson({ jsonSchema: undefined, prompt: 'c' })).resolves.toEqual({
      kind: 'event',
      title: 'Lunch',
    });
    expect(log.filter((line) => line.startsWith('load'))).toHaveLength(2);
  });
});
