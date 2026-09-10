import { type Contact, type GoogleContact } from '@calendar/core';
import { Context, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { CONTACTS_KEY } from './keys.ts';
import { contactFromRow, type ContactRow } from './rows.ts';
import { accountGuard } from './repoShared.ts';

export interface ContactRepoShape {
  /** Incremental sync tombstones: every email row of those persons goes. */
  readonly deleteByResourceNames: (
    accountId: string,
    resourceNames: ReadonlyArray<string>,
  ) => Effect.Effect<void, SqlError>;
  readonly listByAccount: (accountId: string) => Effect.Effect<ReadonlyArray<Contact>, SqlError>;
  /** Full pass: one transaction swaps the whole tier (saved / other) for the account. */
  readonly replaceTier: (params: {
    readonly accountId: string;
    readonly contacts: ReadonlyArray<GoogleContact>;
    readonly isOther: boolean;
    readonly syncedAt: number;
  }) => Effect.Effect<void, SqlError>;
  /**
   * Candidates for the typeahead: email prefix, name substring, or email
   * substring. Coarse on purpose — ranking happens in core, on the merged
   * device + Google list.
   */
  readonly search: (
    query: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<Contact>, SqlError>;
  readonly upsertMany: (
    contacts: ReadonlyArray<GoogleContact>,
    syncedAt: number,
  ) => Effect.Effect<void, SqlError>;
}

/** LIKE wildcards in user input would widen the match; escape them. */
const escapeLike = (text: string): string => text.replaceAll(/[\\%_]/g, String.raw`\$&`);

const makeContactRepo: Effect.Effect<ContactRepoShape, never, Reactivity | SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient;
    const reactivity = yield* Reactivity;
    const mutation = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      reactivity.mutation([CONTACTS_KEY], effect);

    const upsertRow = (contact: GoogleContact, syncedAt: number) => sql`
      INSERT INTO contacts (account_id, resource_name, email_lower, email, display_name,
                            is_other, synced_at)
      SELECT ${contact.accountId}, ${contact.resourceName}, ${contact.email.toLowerCase()},
             ${contact.email}, ${contact.displayName ?? null}, ${contact.isOther ? 1 : 0},
             ${syncedAt}
      ${accountGuard(sql, contact.accountId)}
      ON CONFLICT (account_id, resource_name, email_lower) DO UPDATE SET
        email = excluded.email,
        display_name = excluded.display_name,
        is_other = excluded.is_other,
        synced_at = excluded.synced_at
    `;

    return {
      deleteByResourceNames: (accountId, resourceNames) =>
        resourceNames.length === 0
          ? Effect.void
          : mutation(
              Effect.forEach(
                resourceNames,
                (resourceName) =>
                  sql`DELETE FROM contacts
                      WHERE account_id = ${accountId} AND resource_name = ${resourceName}`,
                { discard: true },
              ),
            ),
      listByAccount: (accountId) =>
        Effect.map(
          sql<ContactRow>`SELECT * FROM contacts WHERE account_id = ${accountId}
                          ORDER BY resource_name, email_lower`,
          (rows) => rows.map(contactFromRow),
        ),
      replaceTier: ({ accountId, contacts, isOther, syncedAt }) =>
        mutation(
          sql.withTransaction(
            Effect.gen(function* () {
              yield* sql`DELETE FROM contacts
                         WHERE account_id = ${accountId} AND is_other = ${isOther ? 1 : 0}`;
              yield* Effect.forEach(contacts, (contact) => upsertRow(contact, syncedAt), {
                discard: true,
              });
            }),
          ),
        ),
      search: (query, limit) => {
        const needle = escapeLike(query.trim().toLowerCase());
        if (needle === '') {
          return Effect.succeed([]);
        }
        return Effect.map(
          sql<ContactRow>`SELECT * FROM contacts
            WHERE email_lower LIKE ${`${needle}%`} ESCAPE '\\'
               OR lower(display_name) LIKE ${`%${needle}%`} ESCAPE '\\'
               OR email_lower LIKE ${`%${needle}%`} ESCAPE '\\'
            ORDER BY is_other, display_name IS NULL, display_name, email_lower
            LIMIT ${limit}`,
          (rows) => rows.map(contactFromRow),
        );
      },
      upsertMany: (contacts, syncedAt) =>
        contacts.length === 0
          ? Effect.void
          : mutation(
              Effect.forEach(contacts, (contact) => upsertRow(contact, syncedAt), {
                discard: true,
              }),
            ),
    };
  },
);

export class ContactRepo extends Context.Service<ContactRepo, ContactRepoShape>()(
  'db/ContactRepo',
) {
  static readonly layer: Layer.Layer<ContactRepo, never, Reactivity | SqlClient> =
    Layer.effect(ContactRepo)(makeContactRepo);
}

/** All repositories, ready to sit on a SqlClient + Reactivity. */
