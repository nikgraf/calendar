import { describe, expect, it } from 'vitest';
import { Contact } from '../types.ts';
import { isValidEmail } from './email.ts';
import { rankContacts } from './search.ts';

const contact = (overrides: Partial<Contact> & { readonly email: string }): Contact =>
  new Contact({
    id: `test:${overrides.email}`,
    source: 'google',
    ...overrides,
  });

const emails = (rows: ReadonlyArray<Contact>) => rows.map((row) => row.email);

describe('rankContacts', () => {
  it('prefers prefix hits, then saved over other contacts, then alphabetical', () => {
    const ranked = rankContacts(
      'al',
      [
        contact({ displayName: 'Salvador', email: 'sal@example.com' }),
        contact({ displayName: 'Alice Other', email: 'alice@other.example', isOtherContact: true }),
        contact({ displayName: 'Bob Alder', email: 'bob@example.com' }),
        contact({ displayName: 'Alice Saved', email: 'alice@saved.example' }),
        contact({ email: 'nomatch@example.com' }),
      ],
      10,
    );
    expect(emails(ranked)).toEqual([
      'alice@saved.example',
      'bob@example.com',
      'alice@other.example',
      'sal@example.com',
    ]);
  });

  it('dedupes by email, keeping the named / higher-tier row', () => {
    const ranked = rankContacts(
      'ali',
      [
        contact({ email: 'Alice@Example.com', isOtherContact: true }),
        contact({ displayName: 'Alice', email: 'alice@example.com', source: 'device' }),
      ],
      10,
    );
    expect(ranked).toHaveLength(1);
    expect(ranked[0]).toMatchObject({ displayName: 'Alice', source: 'device' });
  });

  it('returns nothing for an empty query and honours the limit', () => {
    const many = Array.from({ length: 5 }, (_, index) =>
      contact({ email: `a${index}@example.com` }),
    );
    expect(rankContacts('  ', many, 10)).toEqual([]);
    expect(rankContacts('a', many, 2)).toHaveLength(2);
  });
});

describe('isValidEmail', () => {
  it('accepts plain addresses and rejects fragments', () => {
    expect(isValidEmail(' bob@example.com ')).toBe(true);
    expect(isValidEmail('bob@example')).toBe(false);
    expect(isValidEmail('bob')).toBe(false);
    expect(isValidEmail('bob @example.com')).toBe(false);
  });
});
