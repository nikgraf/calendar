import { getRandomValues, randomUUID } from 'expo-crypto';

type WebCrypto = Partial<Crypto>;

/**
 * Hermes ships without Web Crypto, but shared code needs
 * `crypto.getRandomValues` — event ids are generated with it, so saving an
 * event on a device died with "Property 'crypto' doesn't exist" — and
 * `crypto.randomUUID`, which names the local account rows (sign-in and
 * settings import). The dev client happens to provide the global, which is
 * why the gap only ever appeared in release builds.
 *
 * `expo-crypto` is already a dependency and already inside shipped
 * binaries, so filling the gap here needs no native change and can reach
 * installed builds over the air. Idempotent, and it never replaces a
 * member the runtime already provides: each of the two is filled in on
 * its own.
 */
export const installWebCryptoPolyfill = (): void => {
  const existing = globalThis.crypto as WebCrypto | undefined;
  const hasRandomValues = typeof existing?.getRandomValues === 'function';
  const hasRandomUuid = typeof existing?.randomUUID === 'function';
  if (hasRandomValues && hasRandomUuid) {
    return;
  }
  const uuid = randomUUID as Crypto['randomUUID'];
  if (existing && hasRandomValues) {
    // A runtime with its own getRandomValues keeps its crypto object (a
    // native method must keep its receiver); only the missing member is
    // added. An object that refuses the property falls through to a
    // replacement that delegates with the right `this`.
    try {
      Object.defineProperty(existing, 'randomUUID', {
        configurable: true,
        value: uuid,
        writable: true,
      });
      return;
    } catch {
      const native = existing as Crypto;
      Object.defineProperty(globalThis, 'crypto', {
        configurable: true,
        value: {
          getRandomValues: ((array) => native.getRandomValues(array)) as Crypto['getRandomValues'],
          randomUUID: uuid,
          subtle: native.subtle,
        },
      });
      return;
    }
  }
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: {
      ...existing,
      getRandomValues,
      randomUUID: hasRandomUuid ? existing?.randomUUID : uuid,
    },
  });
};

// Installed on import so a side-effect import from the entry point runs
// before any other module is evaluated — ES imports are hoisted, so an
// explicit call in index.ts would run *after* the app's module graph.
installWebCryptoPolyfill();
