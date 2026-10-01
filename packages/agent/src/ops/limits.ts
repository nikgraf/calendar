import { Effect } from 'effect';
import { AgentInvalidInputError } from '../errors.ts';

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

/** Fails when a text field is longer than the app accepts from an agent. */
export const within = (what: string, value: string | null | undefined, max: number) =>
  typeof value === 'string' && value.length > max
    ? invalid(`${what} is too long (${value.length} characters; at most ${max}).`)
    : Effect.void;
