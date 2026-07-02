// Google Calendar event ids must be base32hex (RFC 2938): characters a–v and
// 0–9, length 5–1024. Generating ids client-side makes events.insert idempotent
// and keeps local and remote ids identical.
const ALPHABET = '0123456789abcdefghijklmnopqrstuv';

export const generateEventId = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(26));
  let id = '';
  for (const byte of bytes) {
    id += ALPHABET[byte % 32];
  }
  return id;
};

export const isValidEventId = (id: string): boolean => /^[0-9a-v]{5,1024}$/.test(id);
