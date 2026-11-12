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
    await takeLlama('spike', async () => undefined);
    await expect(model.status()).resolves.toBe('not-ready');
    await expect(model.generateJson({ jsonSchema: undefined, prompt: 'a' })).rejects.toThrow(
      'Model Spike',
    );
    const unsupported = createAssistantModel({
      runtime,
      state: () => ({ kind: 'unsupported', reason: 'memory' }),
    });
    letGoLlama('spike');
    await expect(unsupported.status()).resolves.toBe('unsupported');
  });
});
