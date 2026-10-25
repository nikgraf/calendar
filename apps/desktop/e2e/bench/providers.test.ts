import { describe, expect, it } from 'vite-plus/test';
import { recording } from './providers.ts';

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
