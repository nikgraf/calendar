import { Effect } from 'effect';
import { AgentInvalidInputError } from '../errors.ts';
import { RGI_EMOJI } from '../summary.ts';

/**
 * Size limits on what an agent may write. They bound what the approval
 * dialog has to show in full (a summary is never shortened) and what a
 * single request can put into the agent store.
 */
export const MAX_TITLE = 500;
export const MAX_LOCATION = 1000;
export const MAX_NOTES = 8000;
export const MAX_URL = 2000;
export const MAX_GUESTS = 100;
export const MAX_RECURRENCE_LINES = 10;
export const MAX_RECURRENCE_LINE = 500;

export const invalid = (message: string) => Effect.fail(new AgentInvalidInputError({ message }));

/** Control characters other than line breaks and tabs, and code points that draw as nothing. */
const HIDDEN = /(?![\t\n\r])[\p{Cc}\p{Default_Ignorable_Code_Point}]/u;

/**
 * The first character of `value` that the approval summary cannot show,
 * as `U+XXXX`, or undefined. Such characters draw as nothing (tag
 * characters, variation selectors, zero-width and bidi controls, a soft
 * hyphen), so an agent could hide text behind them that the user approves
 * without seeing — and that Google then mails to every guest. Refusing
 * them keeps the summary the whole write. Only a complete emoji may carry
 * a joiner or selector: one between pictographs that form no emoji, or on
 * one that needs none, draws as nothing, and its presence or absence can
 * spell bits.
 */
export const hiddenCharacter = (value: string): string | undefined => {
  // A complete emoji keeps its joiners and selectors (they are part of
  // what shows); any left over join or style nothing — a hidden bit.
  const found = value.replaceAll(RGI_EMOJI, '').match(HIDDEN)?.[0];
  return found === undefined
    ? undefined
    : `U+${found.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')}`;
};

/**
 * Fails when a text field is longer than the app accepts from an agent,
 * or carries a character the approval summary cannot show.
 */
export const checkText = (what: string, value: string | null | undefined, max: number) => {
  if (typeof value !== 'string') {
    return Effect.void;
  }
  if (value.length > max) {
    return invalid(`${what} is too long (${value.length} characters; at most ${max}).`);
  }
  const hidden = hiddenCharacter(value);
  return hidden === undefined
    ? Effect.void
    : invalid(
        `${what} contains an invisible or control character (${hidden}); send visible text only.`,
      );
};
