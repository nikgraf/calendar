import { emailKey } from './email.ts';
import { foldSearchText } from '../search/match.ts';
import { Contact } from '../types.ts';

/**
 * Ranks typeahead candidates from every source into one list.
 *
 * Score: a prefix hit on the email or on any word of the name beats a
 * substring hit; non-matches drop out (the SQL/device candidates are
 * coarse). Ties: saved contacts and device contacts (tier 0) rank above
 * Google's "other contacts" (tier 1), then alphabetically. One row per
 * email — the best-scoring source wins, and a named row beats a bare
 * address for the same email.
 */
export const rankContacts = (
  query: string,
  candidates: ReadonlyArray<Contact>,
  limit: number,
): ReadonlyArray<Contact> => {
  const needle = query.trim().toLowerCase();
  if (needle === '' || limit <= 0) {
    return [];
  }
  const scored = new Map<
    string,
    { readonly contact: Contact; readonly score: number; readonly tier: number }
  >();
  for (const contact of candidates) {
    const score = scoreContact(needle, contact);
    if (score === 0) {
      continue;
    }
    const tier = contact.isOtherContact ? 1 : 0;
    const key = emailKey(contact.email);
    const current = scored.get(key);
    if (
      current === undefined ||
      score > current.score ||
      (score === current.score && tier < current.tier) ||
      (score === current.score &&
        tier === current.tier &&
        current.contact.displayName === undefined &&
        contact.displayName !== undefined)
    ) {
      scored.set(key, { contact, score, tier });
    }
  }
  return [...scored.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.tier - b.tier ||
        label(a.contact).localeCompare(label(b.contact)) ||
        emailKey(a.contact.email).localeCompare(emailKey(b.contact.email)),
    )
    .slice(0, limit)
    .map((entry) => entry.contact);
};

const label = (contact: Contact): string => (contact.displayName ?? contact.email).toLowerCase();

const scoreContact = (needle: string, contact: Contact): number => {
  const email = contact.email.toLowerCase();
  const name = contact.displayName?.toLowerCase() ?? '';
  if (email.startsWith(needle) || name.split(/\s+/).some((word) => word.startsWith(needle))) {
    return 3;
  }
  if (name.startsWith(needle)) {
    return 3;
  }
  return email.includes(needle) || name.includes(needle) ? 1 : 0;
};

/** A person by name and address: a contact, or a guest on an event. */
export interface NamedAddress {
  readonly displayName?: string | undefined;
  readonly email: string;
}

const foldName = (text: string): string => foldSearchText(text).replaceAll('ß', 'ss').trim();

const wordsOfName = (text: string): ReadonlyArray<string> =>
  foldName(text)
    .split(/[\s._-]+/u)
    .filter((word) => word !== '');

/** The words a person goes by: their name's, then their address's before the @ ("tom.baker@…"). */
const wordsOf = (person: NamedAddress): ReadonlyArray<string> => [
  ...wordsOfName(person.displayName ?? ''),
  ...wordsOfName(person.email.split('@')[0] ?? ''),
];

/**
 * How well a spoken or typed name names a person, accents and case aside:
 * `exact` — their whole name or address ("Tom Baker", "Jorg Muller" for
 * Jörg Müller); `words` — each of its words is one of theirs, or the
 * initial of one ("Tom", "T Baker" for Tom Baker); `prefix` — each word
 * only begins one of theirs ("Ann" for Anna Lee, "Tom" for Tommy Lee);
 * else undefined.
 */
export const nameMatch = (
  name: string,
  person: NamedAddress,
): 'exact' | 'prefix' | 'words' | undefined => {
  const said = foldName(name);
  if (said === '') {
    return undefined;
  }
  if (
    emailKey(person.email) === said ||
    (person.displayName !== undefined && foldName(person.displayName) === said)
  ) {
    return 'exact';
  }
  const theirs = wordsOf(person);
  const words = wordsOfName(name);
  const whole = (word: string) =>
    theirs.some((part) => part === word || (word.length === 1 && part.startsWith(word)));
  if (words.every(whole)) {
    return 'words';
  }
  return words.every((word) => theirs.some((part) => part.startsWith(word))) ? 'prefix' : undefined;
};

const MATCH_SCORE = { exact: 3, prefix: 1, words: 2 } as const;

/**
 * Every contact a name could mean (`nameMatch`), from every source and
 * not cut short — whether a name means one person is decided over all of
 * them. One row per address (the better-named, saved one kept), best
 * first: exact, then whole words, then prefixes; saved and device
 * contacts before Google's "other contacts"; then alphabetical.
 */
export const contactsNamed = (
  name: string,
  candidates: ReadonlyArray<Contact>,
): ReadonlyArray<Contact> => {
  const scored = new Map<
    string,
    { readonly contact: Contact; readonly score: number; readonly tier: number }
  >();
  for (const contact of candidates) {
    const match = nameMatch(name, contact);
    if (match === undefined) {
      continue;
    }
    const score = MATCH_SCORE[match];
    const tier = contact.isOtherContact ? 1 : 0;
    const key = emailKey(contact.email);
    const current = scored.get(key);
    if (
      current === undefined ||
      score > current.score ||
      (score === current.score && tier < current.tier) ||
      (score === current.score &&
        tier === current.tier &&
        current.contact.displayName === undefined &&
        contact.displayName !== undefined)
    ) {
      scored.set(key, { contact, score, tier });
    }
  }
  return [...scored.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        a.tier - b.tier ||
        label(a.contact).localeCompare(label(b.contact)) ||
        emailKey(a.contact.email).localeCompare(emailKey(b.contact.email)),
    )
    .map((entry) => entry.contact);
};
