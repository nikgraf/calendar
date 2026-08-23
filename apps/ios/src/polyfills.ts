import { getRandomValues } from 'expo-crypto';

/**
 * Hermes ships without Web Crypto, but shared code needs
 * `crypto.getRandomValues` — event ids are generated with it, so saving an
 * event on a device died with "Property 'crypto' doesn't exist". The dev
 * client happens to provide the global, which is why this only ever
 * appeared in release builds.
 *
 * `expo-crypto` is already a dependency and already inside shipped
 * binaries, so filling the gap here needs no native change and can reach
 * installed builds over the air. Idempotent, and it never replaces an
 * implementation the runtime already provides.
 */
export const installWebCryptoPolyfill = (): void => {
  const existing = globalThis.crypto as Partial<Crypto> | undefined;
  if (typeof existing?.getRandomValues === 'function') {
    return;
  }
  Object.defineProperty(globalThis, 'crypto', {
    configurable: true,
    value: { ...existing, getRandomValues },
  });
};

// Installed on import so a side-effect import from the entry point runs
// before any other module is evaluated — ES imports are hoisted, so an
// explicit call in index.ts would run *after* the app's module graph.
installWebCryptoPolyfill();
