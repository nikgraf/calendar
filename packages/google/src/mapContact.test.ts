import { describe, expect, it } from 'vitest';
import { mapPersonBirthday, mapPersonContacts } from './mapContact.ts';

const context = { accountId: 'acc-1', isOther: false };

describe('mapPersonContacts', () => {
  it('yields one row per distinct email, preferring the primary name', () => {
    const rows = mapPersonContacts(
      {
        emailAddresses: [
          { metadata: { primary: true }, value: 'Alice@Example.com' },
          { value: 'alice@example.com' },
          { value: ' alice@work.example ' },
          { value: '' },
        ],
        names: [
          { displayName: 'A. Example' },
          { displayName: 'Alice Example', metadata: { primary: true } },
        ],
        resourceName: 'people/c1',
      },
      context,
    );
    expect(rows.map((row) => row.email)).toEqual(['Alice@Example.com', 'alice@work.example']);
    expect(rows[0]).toMatchObject({
      accountId: 'acc-1',
      displayName: 'Alice Example',
      isOther: false,
      resourceName: 'people/c1',
    });
  });

  it('skips persons without emails and tombstones', () => {
    expect(
      mapPersonContacts({ names: [{ displayName: 'Nobody' }], resourceName: 'people/c2' }, context),
    ).toEqual([]);
    expect(
      mapPersonContacts(
        {
          emailAddresses: [{ value: 'x@example.com' }],
          metadata: { deleted: true },
          resourceName: 'people/c3',
        },
        context,
      ),
    ).toEqual([]);
  });

  it('leaves displayName undefined for nameless other contacts', () => {
    const [row] = mapPersonContacts(
      { emailAddresses: [{ value: 'noreply@example.com' }], resourceName: 'otherContacts/c4' },
      { accountId: 'acc-1', isOther: true },
    );
    expect(row).toMatchObject({ displayName: undefined, isOther: true });
  });
});

describe('mapPersonBirthday', () => {
  it('prefers the primary structured birthday and drops a zero year', () => {
    expect(
      mapPersonBirthday(
        {
          birthdays: [
            { text: 'sometime in spring' },
            { date: { day: 1, month: 1, year: 1980 } },
            { date: { day: 4, month: 3, year: 0 }, metadata: { primary: true } },
          ],
          names: [{ displayName: 'Alice Example', metadata: { primary: true } }],
          resourceName: 'people/c1',
        },
        { accountId: 'acc-1' },
      ),
    ).toMatchObject({
      accountId: 'acc-1',
      day: 4,
      displayName: 'Alice Example',
      month: 3,
      resourceName: 'people/c1',
      year: undefined,
    });
  });

  it('keeps a known year, and needs no email address', () => {
    expect(
      mapPersonBirthday(
        {
          birthdays: [{ date: { day: 29, month: 2, year: 1996 } }],
          names: [{ displayName: 'Leap Person' }],
          resourceName: 'people/c2',
        },
        { accountId: 'acc-1' },
      ),
    ).toMatchObject({ day: 29, month: 2, year: 1996 });
  });

  it('falls back to an email for the name and yields nothing without either', () => {
    expect(
      mapPersonBirthday(
        {
          birthdays: [{ date: { day: 4, month: 3 } }],
          emailAddresses: [{ value: 'x@example.com' }],
          resourceName: 'people/c3',
        },
        { accountId: 'acc-1' },
      )?.displayName,
    ).toBe('x@example.com');
    expect(
      mapPersonBirthday(
        { birthdays: [{ date: { day: 4, month: 3 } }], resourceName: 'people/c4' },
        { accountId: 'acc-1' },
      ),
    ).toBeUndefined();
  });

  it('ignores tombstones, text-only and partial or invalid dates', () => {
    const named = { names: [{ displayName: 'N' }], resourceName: 'people/c5' };
    expect(
      mapPersonBirthday(
        { ...named, birthdays: [{ date: { day: 4, month: 3 } }], metadata: { deleted: true } },
        { accountId: 'acc-1' },
      ),
    ).toBeUndefined();
    expect(
      mapPersonBirthday({ ...named, birthdays: [{ text: 'March 4' }] }, { accountId: 'acc-1' }),
    ).toBeUndefined();
    expect(
      mapPersonBirthday({ ...named, birthdays: [{ date: { month: 3 } }] }, { accountId: 'acc-1' }),
    ).toBeUndefined();
    expect(
      mapPersonBirthday(
        { ...named, birthdays: [{ date: { day: 40, month: 13 } }] },
        { accountId: 'acc-1' },
      ),
    ).toBeUndefined();
  });
});
