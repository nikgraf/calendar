import { GoogleContact } from '@calendar/core';
import type { GcalPerson } from './apiTypes.ts';

/**
 * Splits a People API person into cache rows, one per distinct email
 * (lowercased for identity, original casing kept for display). Persons
 * without an email are useless to the typeahead and yield nothing;
 * tombstones (`metadata.deleted`) are the caller's to remove.
 */
export const mapPersonContacts = (
  person: GcalPerson,
  context: { readonly accountId: string; readonly isOther: boolean },
): ReadonlyArray<GoogleContact> => {
  if (person.metadata?.deleted) {
    return [];
  }
  const primaryName = person.names?.find((name) => name.metadata?.primary)?.displayName;
  const displayName = (primaryName ?? person.names?.[0]?.displayName)?.trim() || undefined;
  const seen = new Set<string>();
  const out: Array<GoogleContact> = [];
  for (const entry of person.emailAddresses ?? []) {
    const email = entry.value?.trim() ?? '';
    const key = email.toLowerCase();
    if (key === '' || seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(
      new GoogleContact({
        accountId: context.accountId,
        displayName,
        email,
        isOther: context.isOther,
        resourceName: person.resourceName,
      }),
    );
  }
  return out;
};
