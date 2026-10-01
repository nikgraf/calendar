import { Effect } from 'effect';

/** Marks a string as a Solunivo agent token (for humans and secret scanners). */
export const TOKEN_PREFIX = 'sol_';

const toBase64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
};

/** A fresh bearer token: 256 random bits. Shown once, never stored. */
export const generateToken = (): string =>
  `${TOKEN_PREFIX}${toBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`;

export const isTokenShaped = (value: unknown): value is string =>
  typeof value === 'string' && /^sol_[\w-]{43}$/u.test(value);

/**
 * SHA-256 of a token, hex. A plain digest is enough because the input is
 * 256 random bits (nothing to brute-force), and it is all the store keeps:
 * a hash cannot be replayed as a token.
 */
export const hashToken = (token: string): Effect.Effect<string> =>
  Effect.promise(async () => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  });
