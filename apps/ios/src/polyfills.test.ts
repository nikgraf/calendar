import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-crypto', () => ({
  getRandomValues: <T extends Uint8Array>(array: T): T => {
    for (let index = 0; index < array.length; index += 1) {
      array[index] = index % 256;
    }
    return array;
  },
}));

const nativeGetRandomValues = (array: Uint8Array) => array.fill(9);

const withGlobalCrypto = <T>(value: unknown, body: () => T): T => {
  const original = globalThis.crypto;
  Object.defineProperty(globalThis, 'crypto', { configurable: true, value });
  try {
    return body();
  } finally {
    Object.defineProperty(globalThis, 'crypto', { configurable: true, value: original });
  }
};

describe('installWebCryptoPolyfill', () => {
  it('fills in getRandomValues where the runtime has none', async () => {
    const { installWebCryptoPolyfill } = await import('./polyfills.ts');
    withGlobalCrypto(undefined, () => {
      installWebCryptoPolyfill();
      const filled = globalThis.crypto.getRandomValues(new Uint8Array(4));
      expect([...filled]).toEqual([0, 1, 2, 3]);
    });
  });

  it('leaves a runtime that already implements it alone', async () => {
    const { installWebCryptoPolyfill } = await import('./polyfills.ts');
    withGlobalCrypto({ getRandomValues: nativeGetRandomValues }, () => {
      installWebCryptoPolyfill();
      expect(globalThis.crypto.getRandomValues).toBe(nativeGetRandomValues);
    });
  });

  it('keeps other crypto members when patching a partial implementation', async () => {
    const { installWebCryptoPolyfill } = await import('./polyfills.ts');
    const subtle = {} as SubtleCrypto;
    withGlobalCrypto({ subtle }, () => {
      installWebCryptoPolyfill();
      expect(globalThis.crypto.subtle).toBe(subtle);
      expect(typeof globalThis.crypto.getRandomValues).toBe('function');
    });
  });
});
