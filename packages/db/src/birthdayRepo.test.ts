import { Account, GoogleBirthday } from '@calendar/core';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { runMigrations } from './migrate.ts';
import { AccountRepo, BirthdayRepo, DeviceSettingsRepo, reposLayer } from './repos.ts';

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

const birthday = (overrides: Partial<GoogleBirthday> = {}): GoogleBirthday =>
  new GoogleBirthday({
    accountId: 'acc-1',
    day: 4,
    displayName: 'Alice Example',
    month: 3,
    resourceName: 'people/c1',
    year: 1994,
    ...overrides,
  });

const names = (rows: ReadonlyArray<{ readonly resourceName: string }>) =>
  rows.map((row) => row.resourceName);

describe('BirthdayRepo', () => {
  it.effect('upserts one row per (account, person) and lists across accounts', () =>
    Effect.gen(function* () {
      const repo = yield* BirthdayRepo;
      yield* repo.upsertMany(
        [
          birthday(),
          birthday({ displayName: 'Alice E.', year: undefined }),
          birthday({ accountId: 'acc-2', resourceName: 'people/c9' }),
        ],
        1,
      );
      const rows = yield* repo.listAll();
      expect(names(rows)).toEqual(['people/c1', 'people/c9']);
      expect(rows[0]!.displayName).toBe('Alice E.');
      expect(rows[0]!.year).toBeUndefined();
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('replaceForAccount drops rows that were not re-sent, other accounts untouched', () =>
    Effect.gen(function* () {
      const repo = yield* BirthdayRepo;
      yield* repo.upsertMany(
        [
          birthday(),
          birthday({ resourceName: 'people/c2' }),
          birthday({ accountId: 'acc-2', resourceName: 'people/c9' }),
        ],
        1,
      );
      yield* repo.replaceForAccount({
        accountId: 'acc-1',
        birthdays: [birthday({ resourceName: 'people/c2' })],
        syncedAt: 2,
      });
      expect(names(yield* repo.listAll())).toEqual(['people/c2', 'people/c9']);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('deleteByResourceNames removes tombstoned persons', () =>
    Effect.gen(function* () {
      const repo = yield* BirthdayRepo;
      yield* repo.upsertMany([birthday(), birthday({ resourceName: 'people/c2' })], 1);
      yield* repo.deleteByResourceNames('acc-1', ['people/c1', 'people/none']);
      expect(names(yield* repo.listAll())).toEqual(['people/c2']);
    }).pipe(Effect.provide(freshDbLayer())),
  );

  it.effect('rows of an unknown account are refused, and removing an account cascades', () =>
    Effect.gen(function* () {
      const repo = yield* BirthdayRepo;
      const accounts = yield* AccountRepo;
      yield* repo.upsertMany([birthday(), birthday({ accountId: 'ghost' })], 1);
      expect(names(yield* repo.listAll())).toEqual(['people/c1']);
      yield* accounts.remove('acc-1');
      expect(yield* repo.listAll()).toEqual([]);
    }).pipe(Effect.provide(freshDbLayer())),
  );
});

describe('DeviceSettingsRepo', () => {
  it.effect('round-trips JSON values, overwrites, and reads a missing key as null', () =>
    Effect.gen(function* () {
      const repo = yield* DeviceSettingsRepo;
      expect(yield* repo.get('birthdayReminders')).toBeNull();
      yield* repo.set('birthdayReminders', { enabled: true, leadDays: [0, 7] });
      expect(yield* repo.get('birthdayReminders')).toEqual({ enabled: true, leadDays: [0, 7] });
      yield* repo.set('birthdayReminders', { enabled: false });
      expect(yield* repo.get('birthdayReminders')).toEqual({ enabled: false });
    }).pipe(Effect.provide(freshDbLayer())),
  );
});
