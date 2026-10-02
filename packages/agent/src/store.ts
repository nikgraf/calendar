import { runMigrationsWith } from '@calendar/db';
import { Context, Effect, Layer, Option, Schema } from 'effect';
import type { ResolvedMigration } from 'effect/sql/Migrator';
import { SqlClient } from 'effect/sql/SqlClient';
import type { SqlError } from 'effect/sql/SqlError';
import type { AgentErrorJson } from './errors.ts';
import { AgentPolicy, EMPTY_POLICY } from './policy.ts';

/**
 * The agent store: who may connect, and what they asked for. It lives in
 * its own desktop-only SQLite file (`agents.db`), not in calendar.db — the
 * phone never has agents, and grants must not ride along with anything
 * that syncs or exports. Only a token's SHA-256 is stored; the token
 * itself is shown once and kept by the agent.
 */

const baseline = Effect.gen(function* () {
  const sql = yield* SqlClient;
  yield* sql`CREATE TABLE agents (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    policy TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  )`;
  // Approval queue and activity log in one: a write that needed approval
  // moves pending → approved → done/failed (or denied/expired); a write
  // the grant allowed outright lands as done/failed, a refused one as
  // blocked. agent_name is copied so the log outlives a removed agent.
  yield* sql`CREATE TABLE agent_requests (
    id TEXT PRIMARY KEY NOT NULL,
    agent_id TEXT NOT NULL,
    agent_name TEXT NOT NULL,
    tool TEXT NOT NULL,
    input TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    summary TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    decided_at INTEGER,
    finished_at INTEGER,
    result TEXT,
    error TEXT
  )`;
  yield* sql`CREATE INDEX agent_requests_status ON agent_requests (status, created_at)`;
  yield* sql`CREATE INDEX agent_requests_created ON agent_requests (created_at)`;
});

export const agentMigrations: ReadonlyArray<ResolvedMigration> = [
  [1, 'agents-baseline', Effect.succeed(baseline)],
];

export const runAgentMigrations: Effect.Effect<void, SqlError, SqlClient> =
  runMigrationsWith(agentMigrations);

export interface AgentRecord {
  readonly createdAt: number;
  readonly id: string;
  readonly lastUsedAt?: number;
  readonly name: string;
  readonly policy: AgentPolicy;
}

export const RequestStatus = Schema.Literals([
  'approved',
  'blocked',
  'denied',
  'done',
  'expired',
  'failed',
  'pending',
]);
export type RequestStatus = typeof RequestStatus.Type;

/** What the user reads before approving, and afterwards in the activity list. Written by the app, never by the agent. */
export const RequestSummary = Schema.Struct({
  lines: Schema.Array(Schema.String),
  title: Schema.String,
});
export type RequestSummary = typeof RequestSummary.Type;

export interface AgentRequestRecord {
  readonly agentId: string;
  readonly agentName: string;
  readonly createdAt: number;
  readonly decidedAt?: number;
  readonly error?: AgentErrorJson;
  readonly finishedAt?: number;
  readonly id: string;
  /** The decoded tool input, replayed through the same checks on approval. */
  readonly input: unknown;
  readonly result?: unknown;
  readonly status: RequestStatus;
  readonly summary: RequestSummary;
  readonly tool: string;
}

interface AgentRow {
  readonly created_at: number;
  readonly id: string;
  readonly last_used_at: number | null;
  readonly name: string;
  readonly policy: string;
}

interface RequestRow {
  readonly agent_id: string;
  readonly agent_name: string;
  readonly created_at: number;
  readonly decided_at: number | null;
  readonly error: string | null;
  readonly finished_at: number | null;
  readonly id: string;
  readonly input: string;
  readonly result: string | null;
  readonly status: string;
  readonly summary: string;
  readonly tool: string;
}

const parseJson = (text: string | null): unknown => {
  if (text === null) {
    return undefined;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const decodePolicy = Schema.decodeUnknownOption(AgentPolicy);
const decodeSummary = Schema.decodeUnknownOption(RequestSummary);
const decodeStatus = Schema.decodeUnknownOption(RequestStatus);

const agentFromRow = (row: AgentRow): AgentRecord => ({
  createdAt: row.created_at,
  id: row.id,
  ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at }),
  name: row.name,
  // A policy this build cannot read grants nothing (fail closed).
  policy: Option.getOrElse(decodePolicy(parseJson(row.policy)), () => EMPTY_POLICY),
});

const errorFromJson = (value: unknown): AgentErrorJson | undefined =>
  typeof value === 'object' &&
  value !== null &&
  'code' in value &&
  'message' in value &&
  typeof value.code === 'string' &&
  typeof value.message === 'string'
    ? (value as AgentErrorJson)
    : undefined;

const requestFromRow = (row: RequestRow): AgentRequestRecord => {
  const error = errorFromJson(parseJson(row.error));
  const result = parseJson(row.result);
  return {
    agentId: row.agent_id,
    agentName: row.agent_name,
    createdAt: row.created_at,
    ...(row.decided_at === null ? {} : { decidedAt: row.decided_at }),
    ...(error === undefined ? {} : { error }),
    ...(row.finished_at === null ? {} : { finishedAt: row.finished_at }),
    id: row.id,
    input: parseJson(row.input),
    ...(result === undefined ? {} : { result }),
    // An unreadable status must never look approvable or successful.
    status: Option.getOrElse(decodeStatus(row.status), () => 'failed' as const),
    summary: Option.getOrElse(decodeSummary(parseJson(row.summary)), () => ({
      lines: [],
      title: row.tool,
    })),
    tool: row.tool,
  };
};

export interface AgentRepoShape {
  readonly count: () => Effect.Effect<number, SqlError>;
  readonly findByTokenHash: (tokenHash: string) => Effect.Effect<AgentRecord | undefined, SqlError>;
  readonly get: (id: string) => Effect.Effect<AgentRecord | undefined, SqlError>;
  readonly insert: (agent: {
    readonly createdAt: number;
    readonly id: string;
    readonly name: string;
    readonly policy: AgentPolicy;
    readonly tokenHash: string;
  }) => Effect.Effect<void, SqlError>;
  readonly list: () => Effect.Effect<ReadonlyArray<AgentRecord>, SqlError>;
  readonly remove: (id: string) => Effect.Effect<void, SqlError>;
  readonly setName: (id: string, name: string) => Effect.Effect<void, SqlError>;
  readonly setPolicy: (id: string, policy: AgentPolicy) => Effect.Effect<void, SqlError>;
  /** Replaces the token: the old one stops working at once. */
  readonly setTokenHash: (id: string, tokenHash: string) => Effect.Effect<void, SqlError>;
  readonly touch: (id: string, at: number) => Effect.Effect<void, SqlError>;
}

const encodePolicy = (policy: AgentPolicy): string => JSON.stringify(policy);

const makeAgentRepo: Effect.Effect<AgentRepoShape, never, SqlClient> = Effect.gen(function* () {
  const sql = yield* SqlClient;
  return {
    count: () =>
      Effect.map(
        sql<{ readonly total: number }>`SELECT COUNT(*) AS total FROM agents`,
        (rows) => rows[0]?.total ?? 0,
      ),
    findByTokenHash: (tokenHash) =>
      Effect.map(sql<AgentRow>`SELECT * FROM agents WHERE token_hash = ${tokenHash}`, (rows) =>
        rows[0] ? agentFromRow(rows[0]) : undefined,
      ),
    get: (id) =>
      Effect.map(sql<AgentRow>`SELECT * FROM agents WHERE id = ${id}`, (rows) =>
        rows[0] ? agentFromRow(rows[0]) : undefined,
      ),
    insert: (agent) =>
      Effect.asVoid(sql`INSERT INTO agents (id, name, token_hash, policy, created_at)
        VALUES (${agent.id}, ${agent.name}, ${agent.tokenHash}, ${encodePolicy(agent.policy)}, ${agent.createdAt})`),
    list: () =>
      Effect.map(sql<AgentRow>`SELECT * FROM agents ORDER BY created_at, id`, (rows) =>
        rows.map(agentFromRow),
      ),
    remove: (id) => Effect.asVoid(sql`DELETE FROM agents WHERE id = ${id}`),
    setName: (id, name) => Effect.asVoid(sql`UPDATE agents SET name = ${name} WHERE id = ${id}`),
    setPolicy: (id, policy) =>
      Effect.asVoid(sql`UPDATE agents SET policy = ${encodePolicy(policy)} WHERE id = ${id}`),
    setTokenHash: (id, tokenHash) =>
      Effect.asVoid(sql`UPDATE agents SET token_hash = ${tokenHash} WHERE id = ${id}`),
    touch: (id, at) => Effect.asVoid(sql`UPDATE agents SET last_used_at = ${at} WHERE id = ${id}`),
  };
});

export class AgentRepo extends Context.Service<AgentRepo, AgentRepoShape>()('agent/AgentRepo') {
  static readonly layer: Layer.Layer<AgentRepo, never, SqlClient> =
    Layer.effect(AgentRepo)(makeAgentRepo);
}

export interface AgentRequestRepoShape {
  readonly countPending: (agentId: string) => Effect.Effect<number, SqlError>;
  /** A removed agent's pending requests can never run; returns their ids. */
  readonly expireForAgent: (
    agentId: string,
    now: number,
  ) => Effect.Effect<ReadonlyArray<string>, SqlError>;
  /** Pending requests created before `olderThan` become expired; returns their ids. */
  readonly expireOlderThan: (
    olderThan: number,
    now: number,
  ) => Effect.Effect<ReadonlyArray<string>, SqlError>;
  /** Requests left mid-execution by a quit: approved → failed. */
  readonly failInterrupted: (now: number, error: AgentErrorJson) => Effect.Effect<void, SqlError>;
  readonly findPending: (
    agentId: string,
    dedupeKey: string,
  ) => Effect.Effect<AgentRequestRecord | undefined, SqlError>;
  readonly get: (id: string) => Effect.Effect<AgentRequestRecord | undefined, SqlError>;
  readonly insert: (
    request: AgentRequestRecord & { readonly dedupeKey: string },
  ) => Effect.Effect<void, SqlError>;
  readonly list: (limit: number) => Effect.Effect<ReadonlyArray<AgentRequestRecord>, SqlError>;
  readonly listPending: () => Effect.Effect<ReadonlyArray<AgentRequestRecord>, SqlError>;
  /**
   * Bounds the log: the newest `keep` finished writes and, counted apart,
   * the newest `keepBlocked` refusals — so an agent hammering at a closed
   * door cannot push what it really did out of the log. Pending and
   * running requests always stay.
   */
  readonly prune: (keep: number, keepBlocked: number) => Effect.Effect<void, SqlError>;
  /**
   * Moves a request from one status to another only if it is still in
   * `from` — the single guard that makes an approval execute once.
   * Returns the updated row, or undefined when someone else got there.
   * A request that has settled drops its stored input: it was kept only
   * to replay the write, and the summary is what the log shows.
   */
  readonly transition: (
    id: string,
    from: RequestStatus,
    to: RequestStatus,
    patch: {
      readonly decidedAt?: number;
      readonly error?: AgentErrorJson;
      readonly finishedAt?: number;
      readonly result?: unknown;
    },
  ) => Effect.Effect<AgentRequestRecord | undefined, SqlError>;
}

const jsonOrNull = (value: unknown): string | null =>
  value === undefined ? null : JSON.stringify(value);

const makeAgentRequestRepo: Effect.Effect<AgentRequestRepoShape, never, SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient;
    const first = (rows: ReadonlyArray<RequestRow>) =>
      rows[0] ? requestFromRow(rows[0]) : undefined;
    return {
      countPending: (agentId) =>
        Effect.map(
          sql<{ readonly total: number }>`SELECT COUNT(*) AS total FROM agent_requests
            WHERE agent_id = ${agentId} AND status = 'pending'`,
          (rows) => rows[0]?.total ?? 0,
        ),
      expireForAgent: (agentId, now) =>
        Effect.map(
          sql<{ readonly id: string }>`UPDATE agent_requests
            SET status = 'expired', finished_at = ${now}, input = 'null'
            WHERE agent_id = ${agentId} AND status = 'pending' RETURNING id`,
          (rows) => rows.map((row) => row.id),
        ),
      expireOlderThan: (olderThan, now) =>
        Effect.map(
          sql<{ readonly id: string }>`UPDATE agent_requests
            SET status = 'expired', finished_at = ${now}, input = 'null'
            WHERE status = 'pending' AND created_at < ${olderThan} RETURNING id`,
          (rows) => rows.map((row) => row.id),
        ),
      failInterrupted: (now, error) =>
        Effect.asVoid(sql`UPDATE agent_requests
          SET status = 'failed', finished_at = ${now}, error = ${JSON.stringify(error)},
            input = 'null'
          WHERE status = 'approved'`),
      findPending: (agentId, dedupeKey) =>
        Effect.map(
          sql<RequestRow>`SELECT * FROM agent_requests
            WHERE agent_id = ${agentId} AND dedupe_key = ${dedupeKey} AND status = 'pending'
            ORDER BY created_at LIMIT 1`,
          first,
        ),
      get: (id) =>
        Effect.map(sql<RequestRow>`SELECT * FROM agent_requests WHERE id = ${id}`, first),
      insert: (request) =>
        Effect.asVoid(sql`INSERT INTO agent_requests
          (id, agent_id, agent_name, tool, input, dedupe_key, summary, status,
           created_at, decided_at, finished_at, result, error)
          VALUES (${request.id}, ${request.agentId}, ${request.agentName}, ${request.tool},
            ${JSON.stringify(request.input ?? null)}, ${request.dedupeKey},
            ${JSON.stringify(request.summary)}, ${request.status}, ${request.createdAt},
            ${request.decidedAt ?? null}, ${request.finishedAt ?? null},
            ${jsonOrNull(request.result)}, ${jsonOrNull(request.error)})`),
      list: (limit) =>
        Effect.map(
          sql<RequestRow>`SELECT * FROM agent_requests
            ORDER BY created_at DESC, id DESC LIMIT ${limit}`,
          (rows) => rows.map(requestFromRow),
        ),
      listPending: () =>
        Effect.map(
          sql<RequestRow>`SELECT * FROM agent_requests WHERE status = 'pending'
            ORDER BY created_at, id`,
          (rows) => rows.map(requestFromRow),
        ),
      prune: (keep, keepBlocked) =>
        Effect.gen(function* () {
          yield* sql`DELETE FROM agent_requests
            WHERE status NOT IN ('pending', 'approved', 'blocked') AND id NOT IN (
              SELECT id FROM agent_requests
              WHERE status NOT IN ('pending', 'approved', 'blocked')
              ORDER BY created_at DESC, id DESC LIMIT ${keep}
            )`;
          yield* sql`DELETE FROM agent_requests
            WHERE status = 'blocked' AND id NOT IN (
              SELECT id FROM agent_requests WHERE status = 'blocked'
              ORDER BY created_at DESC, id DESC LIMIT ${keepBlocked}
            )`;
        }),
      transition: (id, from, to, patch) =>
        Effect.map(
          sql<RequestRow>`UPDATE agent_requests SET
              status = ${to},
              input = CASE WHEN ${to} IN ('pending', 'approved') THEN input ELSE 'null' END,
              decided_at = COALESCE(${patch.decidedAt ?? null}, decided_at),
              finished_at = COALESCE(${patch.finishedAt ?? null}, finished_at),
              result = COALESCE(${jsonOrNull(patch.result)}, result),
              error = COALESCE(${jsonOrNull(patch.error)}, error)
            WHERE id = ${id} AND status = ${from} RETURNING *`,
          first,
        ),
    };
  },
);

export class AgentRequestRepo extends Context.Service<AgentRequestRepo, AgentRequestRepoShape>()(
  'agent/AgentRequestRepo',
) {
  static readonly layer: Layer.Layer<AgentRequestRepo, never, SqlClient> =
    Layer.effect(AgentRequestRepo)(makeAgentRequestRepo);
}

/** Both repos over one SqlClient, migrations applied first. */
export const agentStoreLayer: Layer.Layer<AgentRepo | AgentRequestRepo, SqlError, SqlClient> =
  Layer.mergeAll(AgentRepo.layer, AgentRequestRepo.layer).pipe(
    Layer.provide(Layer.effectDiscard(runAgentMigrations)),
  );
