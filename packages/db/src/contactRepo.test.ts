import { Account, GoogleContact } from '@calendar/core';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { runMigrations } from './migrate.ts';
import { AccountRepo, ContactRepo, reposLayer } from './repos.ts';

const seedAccounts = Effect.gen(function* () {
  const accounts = yield* AccountRepo;
  for (const id of ['acc-1', 'acc-2']) {
    yield* accounts.upsert(
      new Account({
        contactsEnabled: true,
        createdAt: 1,
        email: `${id}@example.com`,
        id,
        provider: 'google',
        status: 'ok',
        tasksEnabled: false,
      }),
    );
  }
});

const freshDbLayer = () =>
  Layer.effectDiscard(seedAccounts).pipe(
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
  );

const contact = (overrides: Partial<GoogleContact> = {}): GoogleContact =>
  new GoogleContact({
    accountId: 'acc-1',
    displayName: 'Alice Example',
    email: 'alice@example.com',
    isOther: false,
    resourceName: 'people/c1',
    ...overrides,
  });

const emails = (rows: ReadonlyArray<{ readonly email: string }>) => rows.map((row) => row.email);

describe('ContactRepo', () => {
  it.effect('upserts by (account, person, email) and searches by prefix or substring', () =>
    Effect.gen(function* () {
      const repo = yield* ContactRepo;
      yield* repo.upsertMany(
        [
          contact(),
          contact({ email: 'alice@work.example', resourceName: 'people/c1' }),
          contact({
            displayName: 'Bob Builder',
            email: 'bob@example.com',
            resourceName: 'people/c2',
          }),
          contact({
            displayName: undefined,
            email: 'newsletter@shop.example',
            isOther: true,
            resourceName: 'otherContacts/o1',
          }),
        ],
        100,
      );
      // Re-upsert with a new name: same key, updated row.
      yield* repo.upsertMany([contact({ displayName: 'Alice E.' })], 200);

      expect(emails(yield* repo.search('ali', 10))).toEqual([
        'alice@example.com',
        'alice@work.example',
      ]);
      expect(emails(yield* repo.search('BUILD', 10))).toEqual(['bob@example.com']);
      expect(emails(yield* repo.search('shop', 10))).toEqual(['newsletter@shop.example']);
      expect(yield* repo.search('', 10)).toEqual([]);
      const [alice] = yield* repo.search('alice@example', 10);
      expect(alice).toMatchObject({
        accountId: 'acc-1',
        displayName: 'Alice E.',
        id: 'google:acc-1:people/c1:alice@example.com',
        isOtherContact: false,
        source: 'google',
      });
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('escapes LIKE wildcards in the query', () =>
    Effect.gen(function* () {
      const repo = yield* ContactRepo;
      yield* repo.upsertMany([contact(), contact({ email: 'a_b@example.com' })], 1);
      expect(emails(yield* repo.search('a_b', 10))).toEqual(['a_b@example.com']);
      expect(yield* repo.search('%', 10)).toEqual([]);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('replaceTier swaps only that tier of that account', () =>
    Effect.gen(function* () {
      const repo = yield* ContactRepo;
      yield* repo.upsertMany(
        [
          contact(),
          contact({ email: 'other@example.com', isOther: true, resourceName: 'otherContacts/o1' }),
          contact({ accountId: 'acc-2', email: 'two@example.com', resourceName: 'people/c9' }),
        ],
        1,
      );
      yield* repo.replaceTier({
        accountId: 'acc-1',
        contacts: [contact({ email: 'fresh@example.com', resourceName: 'people/c3' })],
        isOther: false,
        syncedAt: 2,
      });
      expect(emails(yield* repo.listByAccount('acc-1'))).toEqual([
        'other@example.com',
        'fresh@example.com',
      ]);
      expect(emails(yield* repo.listByAccount('acc-2'))).toEqual(['two@example.com']);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('deleteByResourceNames drops every email of those persons', () =>
    Effect.gen(function* () {
      const repo = yield* ContactRepo;
      yield* repo.upsertMany(
        [
          contact(),
          contact({ email: 'alice@work.example' }),
          contact({ email: 'bob@example.com', resourceName: 'people/c2' }),
        ],
        1,
      );
      yield* repo.deleteByResourceNames('acc-1', ['people/c1']);
      expect(emails(yield* repo.listByAccount('acc-1'))).toEqual(['bob@example.com']);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('removing the account removes its contacts', () =>
    Effect.gen(function* () {
      const repo = yield* ContactRepo;
      yield* repo.upsertMany([contact()], 1);
      yield* (yield* AccountRepo).remove('acc-1');
      expect(yield* repo.listByAccount('acc-1')).toEqual([]);
    }).pipe(Effect.provide(freshDbLayer())),
  );
});
