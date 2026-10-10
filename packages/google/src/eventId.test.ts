import { describe, expect, it } from 'vite-plus/test';
import { generateEventId } from './eventId.ts';

/** Google's rule for a client-chosen id: base32hex (a-v, 0-9), 5–1024 chars. */
const GOOGLE_EVENT_ID = /^[0-9a-v]{5,1024}$/;

describe('eventId', () => {
  it('names the missing polyfill instead of dying on a bare ReferenceError', () => {
    // Hermes has no Web Crypto. Without a polyfill this used to reach the
    // user as `Cause([Die(ReferenceError: Property 'crypto' doesn't exist)])`
    // when saving an event on a real device.
    const original = globalThis.crypto;
    try {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: undefined });
      expect(() => generateEventId()).toThrow(/Web Crypto polyfill/);
    } finally {
      Object.defineProperty(globalThis, 'crypto', { configurable: true, value: original });
    }
    // Still works once the platform provides it.
    expect(generateEventId()).toMatch(GOOGLE_EVENT_ID);
  });

  it('generates ids Google accepts', () => {
    for (let index = 0; index < 200; index += 1) {
      const id = generateEventId();
      // base32hex only: a-v and 0-9, never w-z.
      expect(id).toMatch(GOOGLE_EVENT_ID);
    }
  });

  it('does not repeat', () => {
    const ids = Array.from({ length: 500 }, () => generateEventId());
    expect(new Set(ids).size).toBe(ids.length);
  });
});
