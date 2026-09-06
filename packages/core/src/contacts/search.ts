import { emailKey } from './email.ts';
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
