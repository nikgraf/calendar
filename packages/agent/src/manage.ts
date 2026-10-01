import { Clock, Effect } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { type AgentPolicy, EMPTY_POLICY } from './policy.ts';
import { AgentSignals } from './signals.ts';
import { AgentRepo, type AgentRecord, AgentRequestRepo, type AgentRequestRecord } from './store.ts';
import { generateToken, hashToken, isTokenShaped } from './tokens.ts';

/**
 * What the Settings UI does to agents. Only the app calls these — there
 * is deliberately no tool, rpc or settings-file path that reaches them,
 * so an agent cannot create an agent or widen its own grant.
 */

const MAX_NAME_LENGTH = 60;
/** last_used_at is a hint for the UI: one write a minute is plenty. */
const TOUCH_INTERVAL_MS = 60_000;

const cleanName = (name: string): string => {
  const trimmed = name.trim().replaceAll(/\s+/gu, ' ').slice(0, MAX_NAME_LENGTH);
  return trimmed === '' ? 'Agent' : trimmed;
};

export const listAgents: Effect.Effect<
  ReadonlyArray<AgentRecord>,
  SqlError,
  AgentRepo
> = Effect.flatMap(AgentRepo, (repo) => repo.list());

/** Creates an agent that can do nothing yet; the token is returned once and never again. */
export const createAgent = (
  name: string,
  policy: AgentPolicy = EMPTY_POLICY,
): Effect.Effect<
  { readonly agent: AgentRecord; readonly token: string },
  SqlError,
  AgentRepo | AgentSignals
> =>
  Effect.gen(function* () {
    const token = generateToken();
    const agent: AgentRecord = {
      createdAt: yield* Clock.currentTimeMillis,
      id: crypto.randomUUID(),
      name: cleanName(name),
      policy,
    };
    yield* (yield* AgentRepo).insert({ ...agent, tokenHash: yield* hashToken(token) });
    yield* (yield* AgentSignals).publish({ type: 'agents' });
    return { agent, token };
  });

export const updateAgent = (
  id: string,
  changes: { readonly name?: string | undefined; readonly policy?: AgentPolicy | undefined },
): Effect.Effect<AgentRecord | undefined, SqlError, AgentRepo | AgentSignals> =>
  Effect.gen(function* () {
    const repo = yield* AgentRepo;
    if (changes.name !== undefined) {
      yield* repo.setName(id, cleanName(changes.name));
    }
    if (changes.policy !== undefined) {
      yield* repo.setPolicy(id, changes.policy);
    }
    yield* (yield* AgentSignals).publish({ type: 'agents' });
    return yield* repo.get(id);
  });

/** A new token for an existing agent; the old one stops working immediately. */
export const rotateAgentToken = (
  id: string,
): Effect.Effect<string | undefined, SqlError, AgentRepo | AgentSignals> =>
  Effect.gen(function* () {
    const repo = yield* AgentRepo;
    if (!(yield* repo.get(id))) {
      return undefined;
    }
    const token = generateToken();
    yield* repo.setTokenHash(id, yield* hashToken(token));
    yield* (yield* AgentSignals).publish({ type: 'agents' });
    return token;
  });

/** Removes an agent: its token dies and whatever it had waiting can no longer run. */
export const removeAgent = (
  id: string,
): Effect.Effect<void, SqlError, AgentRepo | AgentRequestRepo | AgentSignals> =>
  Effect.gen(function* () {
    const signals = yield* AgentSignals;
    yield* (yield* AgentRepo).remove(id);
    const expired = yield* (yield* AgentRequestRepo).expireForAgent(
      id,
      yield* Clock.currentTimeMillis,
    );
    for (const requestId of expired) {
      yield* signals.settle(requestId);
    }
    yield* signals.publish({ type: 'agents' });
    yield* signals.publish({ type: 'requests' });
  });

export const listRequests = (
  limit = 50,
): Effect.Effect<ReadonlyArray<AgentRequestRecord>, SqlError, AgentRequestRepo> =>
  Effect.flatMap(AgentRequestRepo, (repo) => repo.list(Math.min(500, Math.max(1, limit))));

export const listPendingRequests: Effect.Effect<
  ReadonlyArray<AgentRequestRecord>,
  SqlError,
  AgentRequestRepo
> = Effect.flatMap(AgentRequestRepo, (repo) => repo.listPending());

/**
 * The agent a token belongs to, read fresh on every call so a changed
 * grant or a removed agent takes effect on the next request of a
 * connection that is already open.
 */
export const authenticate = (
  token: unknown,
): Effect.Effect<AgentRecord | undefined, SqlError, AgentRepo> =>
  Effect.gen(function* () {
    if (!isTokenShaped(token)) {
      return undefined;
    }
    const repo = yield* AgentRepo;
    const agent = yield* repo.findByTokenHash(yield* hashToken(token));
    if (!agent) {
      return undefined;
    }
    const now = yield* Clock.currentTimeMillis;
    if (agent.lastUsedAt === undefined || now - agent.lastUsedAt > TOUCH_INTERVAL_MS) {
      yield* repo.touch(agent.id, now);
    }
    return agent;
  });
