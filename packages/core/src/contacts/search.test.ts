import { describe, expect, it } from 'vite-plus/test';
import { Contact } from '../types.ts';
import { isValidEmail } from './email.ts';
import { contactsNamed, nameMatch, rankContacts } from './search.ts';

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

describe('nameMatch', () => {
  const jorg = { displayName: 'Jörg Müller', email: 'jm@example.com' };
  const tom = { displayName: 'Tom Baker', email: 'tom.baker@example.com' };

  it('reads a whole name or address as exact, accents and case aside', () => {
    expect(nameMatch('Jorg Muller', jorg)).toBe('exact');
    expect(nameMatch('JM@example.com', jorg)).toBe('exact');
  });

  it('reads whole words and initials as words, the start of a word as a prefix', () => {
    expect(nameMatch('Tom', tom)).toBe('words');
    expect(nameMatch('T Baker', tom)).toBe('words');
    expect(nameMatch('baker', tom)).toBe('words');
    expect(nameMatch('Ba', tom)).toBe('prefix');
    expect(nameMatch('To Ba', tom)).toBe('prefix');
    expect(nameMatch('Tim', tom)).toBeUndefined();
    expect(nameMatch('  ', tom)).toBeUndefined();
  });
});

describe('contactsNamed', () => {
  it('finds every contact a name could mean, best first, one row per address, none left out', () => {
    // Review: the typeahead's page of eight could hide a second exact "Tom".
    const toms = Array.from({ length: 8 }, (_, index) =>
      contact({
        displayName: `Tom ${String.fromCharCode(65 + index)}`,
        email: `t${String(index)}@example.com`,
      }),
    );
    const exact = contact({ displayName: 'Tom', email: 'tom@example.com' });
    const otherExact = contact({
      displayName: 'Tom',
      email: 'tom@other.example',
      isOtherContact: true,
    });
    const tommy = contact({ displayName: 'Tommy Lee', email: 'tommy@example.com' });
    const named = contactsNamed('tom', [
      ...toms,
      tommy,
      otherExact,
      exact,
      contact({ email: 'x@example.com' }),
    ]);
    expect(named).toHaveLength(11);
    expect(emails(named.slice(0, 2))).toEqual(['tom@example.com', 'tom@other.example']);
    expect(named.at(-1)?.email).toBe('tommy@example.com');
  });

  it('matches accents and initials the typeahead query does not', () => {
    const jorg = contact({ displayName: 'Jörg Müller', email: 'jm@example.com', source: 'device' });
    expect(emails(contactsNamed('Jorg Muller', [jorg]))).toEqual(['jm@example.com']);
    expect(rankContacts('Jorg Muller', [jorg], 10)).toEqual([]);
    const tom = contact({ displayName: 'Tom Baker', email: 'tb@example.com' });
    expect(emails(contactsNamed('T Baker', [tom]))).toEqual(['tb@example.com']);
  });
});
