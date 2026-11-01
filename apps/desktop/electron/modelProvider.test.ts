import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';

// The keychain: "encrypts" by prefixing, and can be held (a prompt is up)
// or refuse (the prompt was denied).
const keychain = { held: null as Promise<void> | null, refuses: false };
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: {
    decryptStringAsync: async (blob: Buffer) => ({
      result: blob.toString('utf8').slice(3),
      shouldReEncrypt: false,
    }),
    encryptStringAsync: async (text: string) => {
      await keychain.held;
      if (keychain.refuses) {
        throw new Error(
          'Error while encrypting the text provided to safeStorage.encryptStringAsync.',
        );
      }
      return Buffer.from(`v10${text}`, 'utf8');
    },
    isAsyncEncryptionAvailable: async () => true,
  },
}));

/** The module with its own settings file, as on a fresh launch. */
const launch = async () => {
  vi.resetModules();
  keychain.held = null;
  keychain.refuses = false;
  const provider = await import('./modelProvider.ts');
  const dir = mkdtempSync(join(tmpdir(), 'solunivo-model-provider-'));
  provider.initModelProvider(dir);
  const file = () =>
    JSON.parse(readFileSync(join(dir, 'model-provider.json'), 'utf8')) as Record<string, unknown>;
  return { file, provider };
};

describe('model provider settings', () => {
  it('a kind switch made while a save encrypts its key applies after the save', async () => {
    const { file, provider } = await launch();
    await provider.setModelProvider({ kind: 'openai' });
    let answer: (() => void) | undefined;
    keychain.held = new Promise((resolve) => {
      answer = resolve;
    });
    const saved = provider.setModelProvider({
      apiKey: 'sk-test',
      baseUrl: 'http://localhost:1234/v1',
      model: 'qwen3',
    });
    const switched = provider.setModelProvider({ kind: 'ollama' });
    answer?.();
    expect((await saved).hasApiKey).toBe(true);
    await switched;
    expect(provider.getModelProvider()).toEqual({
      ...provider.PROVIDER_DEFAULTS.ollama,
      hasApiKey: false,
    });
    expect(file()).toEqual(provider.PROVIDER_DEFAULTS.ollama);
  });

  it('a key the keychain will not keep is refused and the settings stay as they were', async () => {
    const { provider } = await launch();
    await provider.setModelProvider({ baseUrl: 'http://localhost:1234/v1', kind: 'openai' });
    const before = provider.getModelProvider();
    keychain.refuses = true;
    await expect(provider.setModelProvider({ apiKey: 'sk-test', model: 'qwen3' })).rejects.toThrow(
      'the keychain is not available',
    );
    expect(provider.getModelProvider()).toEqual(before);
    // The refusal does not hold up the next change.
    expect((await provider.setModelProvider({ model: 'qwen3' })).model).toBe('qwen3');
  });
});
