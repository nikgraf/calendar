import type { AttendeeInput } from '../backend.ts';
import { Attendee } from '../types.ts';

const emailKey = (email: string): string => email.trim().toLowerCase();

/**
 * Applies an editor's replacement guest list to the record's attendees.
 * Emails already on the event keep their server-side facts (response,
 * organizer, self); newcomers start as needsAction, which is what Google
 * assigns anyway. Duplicates (by lowercased email) collapse to the first.
 */
export const mergeAttendees = (
  existing: ReadonlyArray<Attendee> | undefined,
  input: ReadonlyArray<AttendeeInput>,
): ReadonlyArray<Attendee> => {
  const known = new Map((existing ?? []).map((attendee) => [emailKey(attendee.email), attendee]));
  const seen = new Set<string>();
  const merged: Array<Attendee> = [];
  for (const entry of input) {
    const key = emailKey(entry.email);
    if (key === '' || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const current = known.get(key);
    merged.push(
      current
        ? new Attendee({ ...current, displayName: entry.displayName ?? current.displayName })
        : new Attendee({
            displayName: entry.displayName,
            email: entry.email.trim(),
            responseStatus: 'needsAction',
          }),
    );
  }
  return merged;
};
