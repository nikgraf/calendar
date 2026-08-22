import { describe, expect, it } from 'vitest';
import { generatePkcePair, generateStateToken } from './pkce.ts';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Decodes base64url back to bytes, so the digest can be compared directly. */
const decode = (value: string): Uint8Array => {
  const base64 = value.replaceAll('-', '+').replaceAll('_', '/');
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
  return Uint8Array.from(binary, (character) => character.codePointAt(0)!);
};

describe('pkce', () => {
  it('derives the challenge from the verifier with S256', async () => {
    const pair = await generatePkcePair();
    // Independently hash the verifier and compare the raw digest bytes.
    const digest = new Uint8Array(
      await crypto.subtle.digest('SHA-256', new TextEncoder().encode(pair.verifier)),
    );
    expect([...decode(pair.challenge)]).toEqual([...digest]);
    // A plain-method verifier would equal its challenge; S256 must not.
    expect(pair.challenge).not.toBe(pair.verifier);
  });

  it('produces RFC 7636-legal, url-safe values', async () => {
    const { challenge, verifier } = await generatePkcePair();
    for (const value of [challenge, verifier]) {
      expect(value).toMatch(BASE64URL);
      // RFC 7636 allows 43-128 characters; padding must be stripped.
      expect(value.length).toBeGreaterThanOrEqual(43);
      expect(value.length).toBeLessThanOrEqual(128);
      expect(value).not.toContain('=');
    }
  });

  it('never repeats a verifier or a state token', async () => {
    const pairs = await Promise.all(Array.from({ length: 25 }, () => generatePkcePair()));
    expect(new Set(pairs.map((pair) => pair.verifier)).size).toBe(pairs.length);

    const states = Array.from({ length: 25 }, () => generateStateToken());
    expect(new Set(states).size).toBe(states.length);
    for (const state of states) {
      expect(state).toMatch(BASE64URL);
      expect(state.length).toBeGreaterThanOrEqual(16);
    }
  });
});
