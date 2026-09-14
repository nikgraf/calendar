import { ContactsClient, makeFakeContactsClient } from '@calendar/contacts';
import { Account, birthdaysInRange, GoogleBirthday } from '@calendar/core';
import { AccountRepo, BirthdayRepo, reposLayer, runMigrations } from '@calendar/db';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { loadMergedBirthdays } from './birthdays.ts';
import { DeviceContacts } from './deviceContacts.ts';

const testLayer = (client: ContactsClient['Service']) =>
  DeviceContacts.layer.pipe(
    Layer.provideMerge(Layer.succeed(ContactsClient, client)),
    Layer.provideMerge(reposLayer),
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
    Layer.provideMerge(reactivityLayer),
  );

const seed = Effect.gen(function* () {
  yield* (yield* AccountRepo).upsert(
    new Account({
      contactsEnabled: true,
      createdAt: 1,
      email: 'nik@example.com',
      id: 'acc-1',
      provider: 'google',
      status: 'ok',
      tasksEnabled: false,
    }),
  );
  yield* (yield* BirthdayRepo).upsertMany(
    [
      new GoogleBirthday({
        accountId: 'acc-1',
        day: 4,
        displayName: 'Alice Example',
        month: 3,
        resourceName: 'people/c1',
        year: 1994,
      }),
      new GoogleBirthday({
        accountId: 'acc-1',
        day: 20,
        displayName: 'Only Google',
        month: 3,
        resourceName: 'people/c2',
      }),
    ],
    1,
  );
});

describe('loadMergedBirthdays', () => {
  it.effect(
    'merges Google and device rows into one record per person, with the account email',
    () => {
      const { client } = makeFakeContactsClient({
        birthdays: [
          { contactId: 'ABC', day: 4, displayName: 'alice example', month: 3 },
          { contactId: 'DEF', day: 9, displayName: 'Only Device', month: 3, year: 1970 },
        ],
      });
      return Effect.gen(function* () {
        yield* seed;
        const records = yield* loadMergedBirthdays;
        expect(
          records.map((record) => [
            record.id,
            record.displayName,
            record.year,
            record.sources.map((source) => `${source.source}:${source.accountEmail ?? '-'}`),
          ]),
        ).toEqual([
          ['google:acc-1:people/c1', 'Alice Example', 1994, ['google:nik@example.com', 'device:-']],
          ['google:acc-1:people/c2', 'Only Google', undefined, ['google:nik@example.com']],
          ['device:DEF', 'Only Device', 1970, ['device:-']],
        ]);
        // The range query, as the handler runs it: one chip for Alice.
        const march = birthdaysInRange(records, '2026-03-01', '2026-03-31');
        expect(march.map((occurrence) => [occurrence.date, occurrence.record.displayName])).toEqual(
          [
            ['2026-03-04', 'Alice Example'],
            ['2026-03-09', 'Only Device'],
            ['2026-03-20', 'Only Google'],
          ],
        );
      }).pipe(Effect.provide(testLayer(client)));
    },
  );

  it.effect('device birthdays are absent without Contacts access', () => {
    const { client } = makeFakeContactsClient({
      authorization: 'denied',
      birthdays: [{ contactId: 'DEF', day: 9, displayName: 'Only Device', month: 3 }],
    });
    return Effect.gen(function* () {
      yield* seed;
      const records = yield* loadMergedBirthdays;
      expect(records.map((record) => record.displayName)).toEqual(['Alice Example', 'Only Google']);
    }).pipe(Effect.provide(testLayer(client)));
  });
});
