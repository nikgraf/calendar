import { describe, expect, it } from 'vitest';
import { mapPersonContacts } from './mapContact.ts';

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
