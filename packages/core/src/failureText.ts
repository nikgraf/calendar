import { format } from 'effect/Formatter';

/**
 * A failure value as one line for a log or a message: an Error as its own
 * string ("Name: message"), a string as it is, anything else as Effect
 * formats it. Never `[object Object]`, which `String()` gives for a plain
 * object (a rejection's or a cause's value is anything at all).
 */
export const failureText = (value: unknown): string =>
  value instanceof Error ? String(value) : typeof value === 'string' ? value : format(value);
