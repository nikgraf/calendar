// Google Calendar event ids must be base32hex (RFC 2938): characters a–v and
// 0–9, length 5–1024. Generating ids client-side makes events.insert idempotent
// and keeps local and remote ids identical.
const ALPHABET = '0123456789abcdefghijklmnopqrstuv';

/**
 * Web Crypto is not universal: Node and Electron have it, but Hermes ships
 * without it, so React Native has to polyfill it before this module runs.
 * Reading it defensively turns a missing polyfill into a message that says
 * what is wrong, rather than a bare ReferenceError surfacing to the user
 * as `Cause([Die(...)])` when they try to save an event.
 */
const randomBytes = (length: number): Uint8Array => {
  const webCrypto = globalThis.crypto as Crypto | undefined;
  if (typeof webCrypto?.getRandomValues !== 'function') {
    throw new TypeError(
      'crypto.getRandomValues is unavailable — this runtime needs a Web Crypto polyfill.',
    );
  }
  return webCrypto.getRandomValues(new Uint8Array(length));
};

export const generateEventId = (): string => {
  const bytes = randomBytes(26);
  let id = '';
  for (const byte of bytes) {
    id += ALPHABET[byte % 32];
  }
  return id;
};

export const isValidEventId = (id: string): boolean => /^[0-9a-v]{5,1024}$/.test(id);
