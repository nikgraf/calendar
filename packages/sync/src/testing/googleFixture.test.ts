import { AccountRepo, reposLayer, runMigrations, TaskRepo } from '@calendar/db';
import {
  GoogleCalendarClient,
  GooglePeopleClient,
  GoogleOAuthConfig,
  GoogleTasksClient,
  TokenManager,
  TokenStore,
} from '@calendar/google';
import { RemindersClient, unavailableRemindersClient } from '@calendar/reminders';
import { unavailableAppleCalendarClient } from '@calendar/apple-calendar';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { describe } from 'vitest';
import { appleCalendarServicesLayer } from '../appleCalendarEvents.ts';
import { SyncEngine } from '../engine.ts';
import { EventMutations } from '../mutations.ts';
import { type GoogleFixture, googleFixtureLayer, seedFixtureAccounts } from './googleFixture.ts';

const fixture: GoogleFixture = {
  accounts: [{ email: 'fixture@solunivo.test', id: 'fixture-google', tasksEnabled: true }],
  taskLists: [{ id: 'mock-list', title: 'Mock Tasks' }],
  tasks: {
    'mock-list': [
      {
        due: '2030-01-02T00:00:00.000Z',
        id: 'task-seeded',
        status: 'needsAction',
        title: 'Seeded task',
        updated: '2030-01-01T00:00:00.000Z',
      },
    ],
  },
};

// The app's composition, with the fixture where the platform layer goes.
const appLayer = SyncEngine.layer.pipe(
  Layer.provideMerge(EventMutations.layer),
  Layer.provideMerge(appleCalendarServicesLayer(unavailableAppleCalendarClient('test'))),
  Layer.provideMerge(reposLayer),
  Layer.provideMerge(Layer.effectDiscard(runMigrations)),
  Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
  Layer.provideMerge(reactivityLayer),
  Layer.provideMerge(Layer.succeed(RemindersClient, unavailableRemindersClient('test'))),
  Layer.provideMerge(GoogleCalendarClient.layer),
  Layer.provideMerge(GoogleTasksClient.layer),
  Layer.provideMerge(GooglePeopleClient.layer),
  Layer.provideMerge(TokenManager.layer),
  Layer.provideMerge(googleFixtureLayer(fixture)),
  Layer.provideMerge(GoogleOAuthConfig.layer({ clientId: 'unconfigured' })),
);

describe('googleFixtureLayer', () => {
  it.effect('seeds the account, hands out a token, and syncs lists and tasks from the fake', () =>
    Effect.gen(function* () {
      yield* seedFixtureAccounts(fixture);
      yield* seedFixtureAccounts(fixture); // idempotent
      const accounts = yield* (yield* AccountRepo).list();
      expect(accounts.map((account) => [account.id, account.status])).toEqual([
        ['fixture-google', 'ok'],
      ]);
      expect(yield* (yield* TokenStore).get('fixture-google')).not.toBeNull();
      yield* (yield* SyncEngine).syncAll();
      const repo = yield* TaskRepo;
      expect((yield* repo.listLists('fixture-google')).map((list) => list.title)).toEqual([
        'Mock Tasks',
      ]);
      expect((yield* repo.getWindow('2030-01-01', '2030-01-03')).map((task) => task.id)).toEqual([
        'task-seeded',
      ]);
      // Still 'ok': the token was accepted, no reauth flip.
      expect((yield* (yield* AccountRepo).get('fixture-google'))?.status).toBe('ok');
    }).pipe(Effect.provide(appLayer)),
  );

  it.effect('a created task pushes and comes back with a server id stamped now', () =>
    Effect.gen(function* () {
      yield* seedFixtureAccounts(fixture);
      yield* (yield* SyncEngine).syncAll();
      const mutations = yield* EventMutations;
      const local = yield* mutations.createTask({
        accountId: 'fixture-google',
        dueDate: '2030-01-02',
        taskListId: 'mock-list',
        title: 'Pushed task',
      });
      expect(local.id.startsWith('local-')).toBe(true);
      yield* mutations.processPendingOps();
      const repo = yield* TaskRepo;
      const pushed = (yield* repo.getWindow('2030-01-01', '2030-01-03')).find(
        (task) => task.title === 'Pushed task',
      );
      expect(pushed?.id.startsWith('local-')).toBe(false);
      // Live stamps: the fake's `updated` is wall-clock, so an incremental
      // pull with a device-time watermark still sees it.
      expect(pushed?.updatedAt).toBeGreaterThan(Date.now() - 60_000);
    }).pipe(Effect.provide(appLayer)),
  );
});
