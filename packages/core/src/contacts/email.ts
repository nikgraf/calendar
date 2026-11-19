/**
 * Good enough to accept a typed invitee: something@something.tld with no
 * whitespace. Google validates for real on insert; this only decides
 * whether Enter/comma/blur turn the text into a chip.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const isValidEmail = (text: string): boolean => EMAIL.test(text.trim());

/** Identity for dedupe: trimmed + lowercased. */
export const emailKey = (email: string): string => email.trim().toLowerCase();

/**
 * A guest as the form and the Assistant's card show one: "Anna Lee
 * (anna@example.com)", so the address a picked name stands for is in
 * sight. An address alone, or a name that is only the address, reads once.
 */
export const nameWithAddress = (person: {
  readonly displayName?: string | undefined;
  readonly email: string;
}): string => {
  const name = person.displayName?.trim();
  return name && emailKey(name) !== emailKey(person.email)
    ? `${name} (${person.email.trim()})`
    : person.email.trim();
};
