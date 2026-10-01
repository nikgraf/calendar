import { SqliteClient } from '@effect/sql-sqlite-node';
import { expect, it } from '@effect/vitest';
import { Effect, Layer } from 'effect';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import { describe } from 'vitest';
import {
  authenticate,
  createAgent,
  listAgents,
  removeAgent,
  rotateAgentToken,
  updateAgent,
} from './manage.ts';
import { EMPTY_POLICY } from './policy.ts';
import { AgentSignals } from './signals.ts';
import { AgentRepo, AgentRequestRepo, type AgentRequestRecord, agentStoreLayer } from './store.ts';
import { hashToken, isTokenShaped } from './tokens.ts';

const layer = Layer.mergeAll(agentStoreLayer, AgentSignals.layer).pipe(
  Layer.provideMerge(SqliteClient.layer({ filename: ':memory:' })),
);

const request = (
  overrides: Partial<AgentRequestRecord & { dedupeKey: string }>,
): AgentRequestRecord & { readonly dedupeKey: string } => ({
  agentId: 'agent-1',
  agentName: 'Hermes',
  createdAt: 100,
  dedupeKey: 'create_event:{}',
  id: 'req-1',
  input: { title: 'Dentist' },
  status: 'pending',
  summary: { lines: ['Calendar: Work'], title: 'Create event “Dentist”' },
  tool: 'create_event',
  ...overrides,
});

describe('agents', () => {
  it.effect('a token is shown once, stored only as a hash, and authenticates its agent', () =>
    Effect.gen(function* () {
      const { agent, token } = yield* createAgent('  Hermes   Agent ');
      expect(agent.name).toBe('Hermes Agent');
      expect(agent.policy).toEqual(EMPTY_POLICY);
      expect(isTokenShaped(token)).toBe(true);

      const sql = yield* SqlClient;
      const rows = yield* sql<{ token_hash: string }>`SELECT * FROM agents`;
      expect(JSON.stringify(rows)).not.toContain(token);
      expect(rows[0]?.token_hash).toBe(yield* hashToken(token));

      expect((yield* authenticate(token))?.id).toBe(agent.id);
      expect(yield* authenticate(`${token.slice(0, -1)}x`)).toBeUndefined();
      expect(yield* authenticate('not-a-token')).toBeUndefined();
      expect(yield* authenticate(undefined)).toBeUndefined();
    }).pipe(Effect.provide(layer)),
  );

  it.effect('rotating replaces the token; removing the agent ends it', () =>
    Effect.gen(function* () {
      const { agent, token } = yield* createAgent('OpenClaw');
      const next = yield* rotateAgentToken(agent.id);
      expect(next).toBeDefined();
      expect(yield* authenticate(token)).toBeUndefined();
      expect((yield* authenticate(next))?.id).toBe(agent.id);

      yield* removeAgent(agent.id);
      expect(yield* authenticate(next)).toBeUndefined();
      expect(yield* listAgents).toEqual([]);
      expect(yield* rotateAgentToken(agent.id)).toBeUndefined();
    }).pipe(Effect.provide(layer)),
  );

  it.effect('a grant change is what the next authenticate returns', () =>
    Effect.gen(function* () {
      const { agent, token } = yield* createAgent('Hermes');
      yield* updateAgent(agent.id, {
        policy: { ...EMPTY_POLICY, calendarDefault: 'read', contacts: true },
      });
      expect((yield* authenticate(token))?.policy).toMatchObject({
        calendarDefault: 'read',
        contacts: true,
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect('a policy this build cannot read grants nothing', () =>
    Effect.gen(function* () {
      const { agent, token } = yield* createAgent('Hermes');
      const sql = yield* SqlClient;
      yield* sql`UPDATE agents SET policy = '{"calendarDefault":"admin"}' WHERE id = ${agent.id}`;
      expect((yield* authenticate(token))?.policy).toEqual(EMPTY_POLICY);
    }).pipe(Effect.provide(layer)),
  );

  it.effect('removing an agent expires what it had waiting and wakes the waiters', () =>
    Effect.gen(function* () {
      const { agent } = yield* createAgent('Hermes');
      const requests = yield* AgentRequestRepo;
      yield* requests.insert(request({ agentId: agent.id }));
      yield* removeAgent(agent.id);
      expect((yield* requests.get('req-1'))?.status).toBe('expired');
      expect(yield* (yield* AgentRepo).count()).toBe(0);
    }).pipe(Effect.provide(layer)),
  );
});

describe('requests', () => {
  it.effect('a transition only happens from the expected status', () =>
    Effect.gen(function* () {
      const requests = yield* AgentRequestRepo;
      yield* requests.insert(request({}));

      const approved = yield* requests.transition('req-1', 'pending', 'approved', {
        decidedAt: 200,
      });
      expect(approved).toMatchObject({ decidedAt: 200, status: 'approved' });
      // The second approval (a double click, another window) finds nothing to move.
      expect(yield* requests.transition('req-1', 'pending', 'approved', {})).toBeUndefined();
      expect(yield* requests.transition('req-1', 'pending', 'denied', {})).toBeUndefined();

      const done = yield* requests.transition('req-1', 'approved', 'done', {
        finishedAt: 300,
        result: { status: 'done' },
      });
      expect(done).toMatchObject({
        decidedAt: 200,
        finishedAt: 300,
        input: { title: 'Dentist' },
        result: { status: 'done' },
        status: 'done',
        summary: { title: 'Create event “Dentist”' },
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect('finds a waiting duplicate, counts pending, and expires old ones', () =>
    Effect.gen(function* () {
      const requests = yield* AgentRequestRepo;
      yield* requests.insert(request({ createdAt: 100, id: 'old' }));
      yield* requests.insert(request({ createdAt: 900, dedupeKey: 'other', id: 'fresh' }));
      yield* requests.insert(request({ agentId: 'agent-2', createdAt: 900, id: 'theirs' }));

      expect((yield* requests.findPending('agent-1', 'create_event:{}'))?.id).toBe('old');
      expect(yield* requests.findPending('agent-1', 'nothing')).toBeUndefined();
      expect(yield* requests.countPending('agent-1')).toBe(2);

      expect(yield* requests.expireOlderThan(500, 1000)).toEqual(['old']);
      expect((yield* requests.get('old'))?.status).toBe('expired');
      expect(yield* requests.countPending('agent-1')).toBe(1);
      expect((yield* requests.listPending()).map((row) => row.id)).toEqual(['fresh', 'theirs']);
    }).pipe(Effect.provide(layer)),
  );

  it.effect('a request left mid-execution by a quit is failed, never re-run', () =>
    Effect.gen(function* () {
      const requests = yield* AgentRequestRepo;
      yield* requests.insert(request({ status: 'approved' }));
      yield* requests.failInterrupted(400, { code: 'Failed', message: 'interrupted' });
      expect(yield* requests.get('req-1')).toMatchObject({
        error: { code: 'Failed', message: 'interrupted' },
        finishedAt: 400,
        status: 'failed',
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect('pruning keeps the newest finished rows and every pending one', () =>
    Effect.gen(function* () {
      const requests = yield* AgentRequestRepo;
      for (let index = 0; index < 6; index += 1) {
        yield* requests.insert(request({ createdAt: index, id: `done-${index}`, status: 'done' }));
      }
      yield* requests.insert(request({ createdAt: -1, id: 'waiting' }));
      yield* requests.prune(2);
      expect((yield* requests.list(50)).map((row) => row.id)).toEqual([
        'done-5',
        'done-4',
        'waiting',
      ]);
    }).pipe(Effect.provide(layer)),
  );
});
