import { describe, expect, it } from 'vitest';
import { generateEventId, isValidEventId } from './eventId.ts';

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
    expect(isValidEventId(generateEventId())).toBe(true);
  });

  it('generates ids Google accepts', () => {
    for (let index = 0; index < 200; index += 1) {
      const id = generateEventId();
      // base32hex only: a-v and 0-9, never w-z.
      expect(isValidEventId(id), id).toBe(true);
    }
  });

  it('does not repeat', () => {
    const ids = Array.from({ length: 500 }, () => generateEventId());
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('rejects ids outside the base32hex alphabet or length', () => {
    expect(isValidEventId('abcdw')).toBe(false);
    expect(isValidEventId('ABCDE')).toBe(false);
    expect(isValidEventId('abc')).toBe(false);
    expect(isValidEventId('')).toBe(false);
    expect(isValidEventId('abc-de')).toBe(false);
    expect(isValidEventId('a'.repeat(1025))).toBe(false);
    expect(isValidEventId('a'.repeat(1024))).toBe(true);
  });
});
