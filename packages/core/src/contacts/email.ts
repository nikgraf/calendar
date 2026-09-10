/**
 * Good enough to accept a typed invitee: something@something.tld with no
 * whitespace. Google validates for real on insert; this only decides
 * whether Enter/comma/blur turn the text into a chip.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const isValidEmail = (text: string): boolean => EMAIL.test(text.trim());

/** Identity for dedupe: trimmed + lowercased. */
export const emailKey = (email: string): string => email.trim().toLowerCase();
