import { Contact } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import { applyGuestChange, guestsNamed, pickContact, resolveInvitees } from './draftInvitees.ts';

const contact = (displayName: string | undefined, email: string): Contact =>
  new Contact({
    ...(displayName ? { displayName } : {}),
    email,
    id: `test:${email}`,
    source: 'google',
  });

const tomBaker = contact('Tom Baker', 'tom.baker@example.com');
const tomLee = contact('Tom Lee', 'tlee@example.com');
const joanna = contact('Joanna Smith', 'joanna@example.com');
const jorg = contact('Jörg Müller', 'jm@example.com');

describe('pickContact', () => {
  it('takes the one contact by exactly that name, accents and case aside', () => {
    expect(pickContact('tom baker', [tomBaker, tomLee])).toBe(tomBaker);
    expect(pickContact('Jorg Muller', [jorg])).toBe(jorg);
  });

  it('takes the only contact the name begins word by word', () => {
    expect(pickContact('Tom', [tomBaker])).toBe(tomBaker);
    expect(pickContact('T Baker', [tomBaker, tomLee])).toBe(tomBaker);
    // The address counts as a name when there is none.
    expect(pickContact('Lee', [contact(undefined, 'lee@example.com')])?.email).toBe(
      'lee@example.com',
    );
  });

  it('leaves it to the user when it could be several, or only part of a name', () => {
    expect(pickContact('Tom', [tomBaker, tomLee])).toBeUndefined();
    // "Ann" is not Joanna, though the search found her.
    expect(pickContact('Ann', [joanna])).toBeUndefined();
    // One person, two addresses: the user picks the address.
    const work = contact('Tom Baker', 'tom@work.example.com');
    expect(pickContact('Tom Baker', [tomBaker, work])).toBeUndefined();
  });
});

/** A search that finds the same contacts for every name. */
const search = (contacts: ReadonlyArray<Contact>) => async () => contacts;

describe('resolveInvitees', () => {
  it('makes guests of addresses and names that mean one contact, and choices of the rest', async () => {
    const queries: Array<string> = [];
    const result = await resolveInvitees(['Tom Baker', 'Anna', 'bo@example.com'], async (query) => {
      queries.push(query);
      return query === 'Tom Baker' ? [tomBaker, tomLee] : [];
    });
    expect(result).toEqual({
      add: [
        { displayName: 'Tom Baker', email: 'tom.baker@example.com' },
        { email: 'bo@example.com' },
      ],
      choices: [{ contacts: [], name: 'Anna' }],
    });
    // An address is not looked up.
    expect(queries).toEqual(['Tom Baker', 'Anna']);
  });

  it('offers the contacts a name could be, the ones it names first', async () => {
    const result = await resolveInvitees(['Tom'], search([joanna, tomBaker, tomLee]));
    expect(result.choices).toEqual([{ contacts: [tomBaker, tomLee], name: 'Tom' }]);
    // None it names: what the search found.
    expect((await resolveInvitees(['Ann'], search([joanna]))).choices).toEqual([
      { contacts: [joanna], name: 'Ann' },
    ]);
  });

  it('reads a failing search as finding no one', async () => {
    const result = await resolveInvitees(['Tom'], () => Promise.reject(new Error('offline')));
    expect(result).toEqual({ add: [], choices: [{ contacts: [], name: 'Tom' }] });
  });
});

describe('guestsNamed and applyGuestChange', () => {
  const guests = [
    { displayName: 'Tom Baker', email: 'tom.baker@example.com' },
    { displayName: 'Tom Lee', email: 'tlee@example.com' },
    { email: 'anna@example.com' },
  ];

  it('finds the guests a name takes off, and none when it could be several', () => {
    expect(guestsNamed('Tom Baker', guests)).toEqual([guests[0]]);
    expect(guestsNamed('ANNA@example.com', guests)).toEqual([guests[2]]);
    expect(guestsNamed('Anna', guests)).toEqual([guests[2]]);
    expect(guestsNamed('Tom', guests)).toEqual([]);
  });

  it('takes guests off, adds new ones once, and settles choices said again', () => {
    const result = applyGuestChange(
      guests,
      [
        { contacts: [], name: 'Mia' },
        { contacts: [], name: 'Bo' },
      ],
      {
        add: [
          { email: 'TLEE@example.com' },
          { displayName: 'Jörg Müller', email: 'jm@example.com' },
        ],
        choices: [{ contacts: [tomBaker], name: 'mia' }],
        remove: ['Anna', 'Bo'],
      },
    );
    expect(result.removed).toEqual([guests[2]]);
    expect(result.added).toEqual([{ displayName: 'Jörg Müller', email: 'jm@example.com' }]);
    expect(result.attendees).toEqual([
      guests[0],
      guests[1],
      { displayName: 'Jörg Müller', email: 'jm@example.com' },
    ]);
    // Mia's old choice gives way to the new one; Bo's goes with the removal.
    expect(result.choices).toEqual([{ contacts: [tomBaker], name: 'mia' }]);
  });
});
