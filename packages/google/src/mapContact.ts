import { GoogleBirthday, GoogleContact } from '@calendar/core';
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

/**
 * The structured birthday of a saved contact, or undefined: tombstones,
 * text-only birthdays and persons without a name yield nothing. Unlike
 * the email rows, a person needs no address here — a birthday is worth
 * showing on its own. Google sends year 0 (or none) for year-less dates.
 */
export const mapPersonBirthday = (
  person: GcalPerson,
  context: { readonly accountId: string },
): GoogleBirthday | undefined => {
  if (person.metadata?.deleted) {
    return undefined;
  }
  const entries = person.birthdays ?? [];
  const chosen =
    entries.find((entry) => entry.metadata?.primary && entry.date) ??
    entries.find((entry) => entry.date);
  const date = chosen?.date;
  if (!date || date.month === undefined || date.day === undefined) {
    return undefined;
  }
  if (date.month < 1 || date.month > 12 || date.day < 1 || date.day > 31) {
    return undefined;
  }
  const primaryName = person.names?.find((name) => name.metadata?.primary)?.displayName;
  const displayName =
    (primaryName ?? person.names?.[0]?.displayName)?.trim() ||
    person.emailAddresses?.find((entry) => entry.value?.trim())?.value?.trim();
  if (!displayName) {
    return undefined;
  }
  return new GoogleBirthday({
    accountId: context.accountId,
    day: date.day,
    displayName,
    month: date.month,
    resourceName: person.resourceName,
    year: date.year !== undefined && date.year > 0 ? date.year : undefined,
  });
};
