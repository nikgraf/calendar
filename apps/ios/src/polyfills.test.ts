import { describe, expect, it, vi } from 'vite-plus/test';

const POLYFILL_UUID = '00000000-0000-4000-8000-000000000000';

vi.mock('expo-crypto', () => ({
  getRandomValues: <T extends Uint8Array>(array: T): T => {
    for (let index = 0; index < array.length; index += 1) {
      array[index] = index % 256;
    }
    return array;
  },
  randomUUID: () => POLYFILL_UUID,
}));

const nativeGetRandomValues = (array: Uint8Array) => array.fill(9);
const nativeRandomUuid = () => '11111111-1111-4111-8111-111111111111';

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
  it('fills in getRandomValues and randomUUID where the runtime has none', async () => {
    const { installWebCryptoPolyfill } = await import('./polyfills.ts');
    withGlobalCrypto(undefined, () => {
      installWebCryptoPolyfill();
      const filled = globalThis.crypto.getRandomValues(new Uint8Array(4));
      expect([...filled]).toEqual([0, 1, 2, 3]);
      expect(globalThis.crypto.randomUUID()).toBe(POLYFILL_UUID);
    });
  });

  it('leaves a runtime that already implements both alone', async () => {
    const { installWebCryptoPolyfill } = await import('./polyfills.ts');
    const native = { getRandomValues: nativeGetRandomValues, randomUUID: nativeRandomUuid };
    withGlobalCrypto(native, () => {
      installWebCryptoPolyfill();
      expect(globalThis.crypto).toBe(native);
      expect(globalThis.crypto.getRandomValues).toBe(nativeGetRandomValues);
      expect(globalThis.crypto.randomUUID).toBe(nativeRandomUuid);
    });
  });

  it('adds only randomUUID to a runtime with its own getRandomValues, on the same object', async () => {
    const { installWebCryptoPolyfill } = await import('./polyfills.ts');
    const native = { getRandomValues: nativeGetRandomValues };
    withGlobalCrypto(native, () => {
      installWebCryptoPolyfill();
      expect(globalThis.crypto).toBe(native);
      expect(globalThis.crypto.getRandomValues).toBe(nativeGetRandomValues);
      expect(globalThis.crypto.randomUUID()).toBe(POLYFILL_UUID);
    });
  });

  it('wraps a crypto object that refuses new members, keeping its receiver', async () => {
    const { installWebCryptoPolyfill } = await import('./polyfills.ts');
    const native = Object.freeze({
      getRandomValues(this: unknown, array: Uint8Array) {
        // A native method throws "Illegal invocation" off its receiver.
        if (this !== native) {
          throw new TypeError('Illegal invocation');
        }
        return array.fill(7);
      },
    });
    withGlobalCrypto(native, () => {
      installWebCryptoPolyfill();
      expect([...globalThis.crypto.getRandomValues(new Uint8Array(2))]).toEqual([7, 7]);
      expect(globalThis.crypto.randomUUID()).toBe(POLYFILL_UUID);
    });
  });

  it('keeps a native randomUUID when only getRandomValues is missing', async () => {
    const { installWebCryptoPolyfill } = await import('./polyfills.ts');
    withGlobalCrypto({ randomUUID: nativeRandomUuid }, () => {
      installWebCryptoPolyfill();
      expect(globalThis.crypto.randomUUID).toBe(nativeRandomUuid);
      expect([...globalThis.crypto.getRandomValues(new Uint8Array(2))]).toEqual([0, 1]);
    });
  });

  it('keeps other crypto members when patching a partial implementation', async () => {
    const { installWebCryptoPolyfill } = await import('./polyfills.ts');
    const subtle = {} as SubtleCrypto;
    withGlobalCrypto({ subtle }, () => {
      installWebCryptoPolyfill();
      expect(globalThis.crypto.subtle).toBe(subtle);
      expect(typeof globalThis.crypto.getRandomValues).toBe('function');
      expect(typeof globalThis.crypto.randomUUID).toBe('function');
    });
  });
});
