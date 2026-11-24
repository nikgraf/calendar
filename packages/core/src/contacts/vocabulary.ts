import { isMappableLocation } from '../geo/location.ts';
import type { Contact, EventRecord } from '../types.ts';

/**
 * The names dictation's Parakeet listens for (Settings › Dictation › Read
 * With Parakeet): the people and places the user is likely to say, so a
 * name it heard almost right is written as the user writes it. Measured
 * on Nik's recordings (#378): with the clips' people listed every full
 * name came out right, with their places too 7 % of the words were wrong
 * instead of 16 %. A listed place can also be written over words that
 * only sound like it, so the lists hold what the calendar itself names,
 * the likeliest first, and no more than `VOCABULARY_LIMIT` of each.
 */
export interface DictationVocabulary {
  readonly people: ReadonlyArray<string>;
  readonly places: ReadonlyArray<string>;
}

/** Names of each kind at most: every one is rescored against every phrase. */
export const VOCABULARY_LIMIT = 100;
/** Longer is a sentence, not a name. */
const MAX_NAME_LETTERS = 40;

/** A name as listed: spaces made single, nothing but punctuation dropped. */
const tidy = (text: string): string | undefined => {
  const name = text.normalize('NFC').replaceAll(/\s+/gu, ' ').trim();
  return name.length >= 2 && name.length <= MAX_NAME_LETTERS && /\p{L}/u.test(name)
    ? name
    : undefined;
};

/** Counted names, the most often seen first, then the latest. */
class Tally {
  private readonly names = new Map<string, { count: number; last: number; name: string }>();

  add(text: string | undefined, at: number): void {
    const name = text === undefined ? undefined : tidy(text);
    if (name === undefined) {
      return;
    }
    const key = name.toLowerCase();
    const seen = this.names.get(key);
    this.names.set(key, {
      count: (seen?.count ?? 0) + 1,
      last: Math.max(seen?.last ?? at, at),
      name: seen?.name ?? name,
    });
  }

  has(text: string): boolean {
    const name = tidy(text);
    return name !== undefined && this.names.has(name.toLowerCase());
  }

  ranked(): ReadonlyArray<string> {
    return [...this.names.values()]
      .sort((a, b) => b.count - a.count || b.last - a.last || a.name.localeCompare(b.name))
      .map((entry) => entry.name);
  }
}

/**
 * The place an event's location names, as it would be said: the place's
 * own name where MapKit gave one, else the text before its first comma
 * ("Figlmüller, Wollzeile 5" → "Figlmüller"), a house number left off
 * ("Neubaugasse 12" → "Neubaugasse"). Nothing for a link or a call.
 */
const placeOf = (event: EventRecord): string | undefined => {
  if (!isMappableLocation(event.location)) {
    return undefined;
  }
  const named = event.geo?.name?.trim();
  const first = event.location.split(',')[0] ?? '';
  return (named === undefined || named === '' ? first : named).replace(/\s+\d+\w?$/u, '');
};

/**
 * The people and places of a year of events, with the contacts' names after
 * the people met: guests counted by how often they came (the user and
 * rooms left out), places by how often an event was there.
 */
export const dictationVocabulary = (
  events: ReadonlyArray<EventRecord>,
  contacts: ReadonlyArray<Contact>,
  limit: number = VOCABULARY_LIMIT,
): DictationVocabulary => {
  const people = new Tally();
  const places = new Tally();
  for (const event of events) {
    if (event.status === 'cancelled') {
      continue;
    }
    for (const guest of event.attendees ?? []) {
      if (guest.isSelf !== true && guest.isResource !== true) {
        people.add(guest.displayName, event.startUtc);
      }
    }
    places.add(placeOf(event), event.startUtc);
  }
  const met = people.ranked();
  const known = new Tally();
  for (const contact of contacts) {
    if (contact.displayName !== undefined && !people.has(contact.displayName)) {
      known.add(contact.displayName, 0);
    }
  }
  return {
    people: [...met, ...known.ranked()].slice(0, limit),
    places: places.ranked().slice(0, limit),
  };
};
