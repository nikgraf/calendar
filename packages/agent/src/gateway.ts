import type { AppleCalendarClient } from '@calendar/apple-calendar';
import type {
  AccountRepo,
  CalendarRepo,
  ContactRepo,
  DeviceSettingsRepo,
  EventRepo,
  TaskRepo,
} from '@calendar/db';
import type { AppleCalendarEvents, DeviceContacts, EventMutations } from '@calendar/sync';
import { Clock, Effect, Schema } from 'effect';
import { isToolName, isWriteTool, type ToolInput, type ToolName, TOOLS } from './contract.ts';
import {
  type AgentError,
  agentErrorFromJson,
  agentErrorJson,
  type AgentErrorJson,
  AgentFailedError,
  AgentInvalidInputError,
  AgentLimitError,
  AgentNotFoundError,
  AgentPermissionDeniedError,
  toAgentError,
} from './errors.ts';
import {
  planCreateEvent,
  planDeleteEvent,
  planRespondToEvent,
  planUpdateEvent,
} from './ops/events.ts';
import type { WritePlan, WriteResult } from './ops/plan.ts';
import {
  findSlots,
  getFreeBusy,
  listCalendars,
  listEvents,
  listTaskLists,
  listTasks,
  searchContacts,
} from './ops/read.ts';
import { planCreateTask, planDeleteTask, planUpdateTask } from './ops/tasks.ts';
import type { DeniedReason } from './policy.ts';
import { loadDirectory } from './resolve.ts';
import { sameSummary } from './summary.ts';
import { AgentSignals } from './signals.ts';
import {
  AgentRepo,
  type AgentRecord,
  AgentRequestRepo,
  type AgentRequestRecord,
  type RequestSummary,
} from './store.ts';

/** The backend services a tool call reaches — a strict subset of the app backend. */
export type GatewayBackend =
  | AccountRepo
  | AppleCalendarClient
  | AppleCalendarEvents
  | CalendarRepo
  | ContactRepo
  | DeviceContacts
  | DeviceSettingsRepo
  | EventMutations
  | EventRepo
  | TaskRepo;

export type GatewayServices = AgentRepo | AgentRequestRepo | AgentSignals | GatewayBackend;

/** How long an ask-first call waits for the user before handing back a request id. */
export const APPROVAL_WAIT_MS = 25_000;
/** A request nobody answered stops being approvable after a day. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
/** Requests one agent may have waiting at once. */
export const MAX_PENDING_PER_AGENT = 10;
/** Finished rows the activity log keeps — and, counted apart, refusals. */
export const ACTIVITY_LOG_SIZE = 500;
export const BLOCKED_LOG_SIZE = 100;

const DENIED_MESSAGE: Record<DeniedReason, string> = {
  guests:
    'This write reaches other people (the event has or gains guests) and this agent may not do that. The user can allow it in Solunivo → Settings → Agents.',
  level:
    'This agent may read here but not write. The user can change that in Solunivo → Settings → Agents.',
  readOnly: 'The calendar or list is read-only at its provider; nothing can be written to it.',
};

const formatIssue = (error: unknown): string =>
  String(error instanceof Error ? error.message : error).slice(0, 600);

const decodeInput = <Name extends ToolName>(name: Name, raw: unknown) =>
  Schema.decodeUnknownEffect(TOOLS[name].input as Schema.Codec<ToolInput<Name>, unknown>)(
    raw ?? {},
    { onExcessProperty: 'error' },
  ).pipe(
    Effect.mapError(
      (error) =>
        new AgentInvalidInputError({ message: `Invalid input for ${name}: ${formatIssue(error)}` }),
    ),
  );

/** Key order must not make two identical requests look different. */
const stable = (value: unknown): string =>
  JSON.stringify(value, (_key, inner: unknown) =>
    typeof inner === 'object' && inner !== null && !Array.isArray(inner)
      ? Object.fromEntries(Object.entries(inner).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : inner,
  );

const newId = (): string => crypto.randomUUID();

const planWrite = (
  agent: AgentRecord,
  name: ToolName,
  input: unknown,
): Effect.Effect<WritePlan<GatewayBackend>, unknown, GatewayBackend> =>
  Effect.gen(function* () {
    const directory = yield* loadDirectory(agent.policy);
    switch (name) {
      case 'create_event': {
        return yield* planCreateEvent(agent.policy, directory, input as ToolInput<'create_event'>);
      }
      case 'update_event': {
        return yield* planUpdateEvent(agent.policy, directory, input as ToolInput<'update_event'>);
      }
      case 'delete_event': {
        return yield* planDeleteEvent(agent.policy, directory, input as ToolInput<'delete_event'>);
      }
      case 'respond_to_event': {
        return yield* planRespondToEvent(
          agent.policy,
          directory,
          input as ToolInput<'respond_to_event'>,
        );
      }
      case 'create_task': {
        return yield* planCreateTask(agent.policy, directory, input as ToolInput<'create_task'>);
      }
      case 'update_task': {
        return yield* planUpdateTask(agent.policy, directory, input as ToolInput<'update_task'>);
      }
      case 'delete_task': {
        return yield* planDeleteTask(agent.policy, directory, input as ToolInput<'delete_task'>);
      }
      default: {
        return yield* Effect.fail(
          new AgentInvalidInputError({ message: `${name} is not a write.` }),
        );
      }
    }
  });

/** Runs a planned write; a defect is a failure of this write, not of the gateway. */
const runPlan = (
  plan: WritePlan<GatewayBackend>,
): Effect.Effect<WriteResult, AgentError, GatewayBackend> =>
  plan.run.pipe(
    Effect.mapError(toAgentError),
    Effect.catchDefect((defect) =>
      Effect.fail(new AgentFailedError({ message: formatIssue(defect), tag: 'Defect' })),
    ),
  );

const logRow = (
  agent: AgentRecord,
  name: ToolName,
  summary: RequestSummary,
  outcome:
    | { readonly error: AgentErrorJson; readonly status: 'blocked' | 'failed' }
    | { readonly result: WriteResult; readonly status: 'done' },
) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const requests = yield* AgentRequestRepo;
    // A finished write is logged by its summary alone: the input was only
    // ever needed to replay a request that is still waiting.
    yield* requests.insert({
      agentId: agent.id,
      agentName: agent.name,
      createdAt: now,
      dedupeKey: '',
      finishedAt: now,
      id: newId(),
      input: null,
      status: outcome.status,
      summary,
      tool: name,
      ...(outcome.status === 'done' ? { result: outcome.result } : { error: outcome.error }),
    });
    yield* requests.prune(ACTIVITY_LOG_SIZE, BLOCKED_LOG_SIZE);
    yield* (yield* AgentSignals).publish({ type: 'requests' });
  }).pipe(
    // The log must never turn a finished write into a failed call.
    Effect.catchCause((cause) => Effect.logWarning('agent activity log write failed', cause)),
  );

/** What an agent is told about a request (its own only). */
export const requestView = (
  request: AgentRequestRecord,
): Readonly<Record<string, unknown>> & { readonly requestId: string; readonly status: string } => {
  switch (request.status) {
    case 'pending': {
      return {
        message:
          'Waiting for the user to approve this in Solunivo. Do not send the write again; call get_request with this requestId to see the outcome.',
        requestId: request.id,
        status: 'pending_approval',
      };
    }
    case 'approved': {
      return { requestId: request.id, status: 'executing' };
    }
    case 'done': {
      return {
        requestId: request.id,
        result: request.result ?? { status: 'done' },
        status: 'done',
      };
    }
    case 'denied': {
      return {
        message: 'The user declined this request. Do not retry it unless the user asks.',
        requestId: request.id,
        status: 'denied',
      };
    }
    case 'expired': {
      return {
        message: 'Nobody answered this request in time; it will not run.',
        requestId: request.id,
        status: 'expired',
      };
    }
    default: {
      return {
        error: request.error ?? { code: 'Failed', message: 'The write failed.' },
        requestId: request.id,
        status: 'failed',
      };
    }
  }
};

/** A settled request as the answer to the call that created it. */
const settledAnswer = (request: AgentRequestRecord): Effect.Effect<unknown, AgentError> => {
  switch (request.status) {
    case 'done': {
      return Effect.succeed(request.result ?? { status: 'done' });
    }
    case 'denied': {
      return Effect.fail(
        new AgentPermissionDeniedError({
          message: 'The user declined this request. Do not retry it unless the user asks.',
          reason: 'userDenied',
        }),
      );
    }
    case 'failed':
    case 'blocked': {
      return Effect.fail(
        request.error
          ? agentErrorFromJson(request.error)
          : new AgentFailedError({ message: 'The write failed.', tag: 'Failed' }),
      );
    }
    case 'expired': {
      return Effect.fail(
        new AgentFailedError({
          message: 'Nobody answered this request in time; nothing was written.',
          tag: 'Expired',
        }),
      );
    }
    default: {
      return Effect.succeed(requestView(request));
    }
  }
};

const requestApproval = (
  agent: AgentRecord,
  name: ToolName,
  input: unknown,
  summary: RequestSummary,
) =>
  Effect.gen(function* () {
    const requests = yield* AgentRequestRepo;
    const signals = yield* AgentSignals;
    const dedupeKey = `${name}:${stable(input)}`;
    // A retry of the same write joins the request already waiting.
    let request = yield* requests.findPending(agent.id, dedupeKey);
    if (!request) {
      if ((yield* requests.countPending(agent.id)) >= MAX_PENDING_PER_AGENT) {
        return yield* Effect.fail(
          new AgentLimitError({
            message: `${MAX_PENDING_PER_AGENT} requests are already waiting for the user's approval. Wait for those before asking for more.`,
          }),
        );
      }
      request = {
        agentId: agent.id,
        agentName: agent.name,
        createdAt: yield* Clock.currentTimeMillis,
        id: newId(),
        input,
        status: 'pending',
        summary,
        tool: name,
      };
      yield* requests.insert({ ...request, dedupeKey });
      yield* signals.publish({ request, type: 'approvalRequested' });
    }
    yield* signals.awaitSettled(request.id, APPROVAL_WAIT_MS);
    const latest = (yield* requests.get(request.id)) ?? request;
    return yield* settledAnswer(latest);
  });

/**
 * One write, start to finish. `approved` is the replay of a request the
 * user said yes to: it is planned again from the stored input, so a grant
 * narrowed or an item moved since then still stops it — only "ask" turns
 * into "go".
 */
const executeWrite = (
  agent: AgentRecord,
  name: ToolName,
  input: unknown,
  /** `approved` carries the summary the user said yes to. */
  mode: 'direct' | { readonly approved: RequestSummary },
): Effect.Effect<unknown, AgentError, GatewayServices> =>
  Effect.gen(function* () {
    const plan = yield* planWrite(agent, name, input).pipe(Effect.mapError(toAgentError));
    // The user approved a description, not an input: if planning the same
    // input now describes anything else — the event was renamed, gained
    // guests, moved — the approval does not cover it.
    if (mode !== 'direct' && !sameSummary(plan.summary, mode.approved)) {
      return yield* Effect.fail(
        new AgentFailedError({
          message:
            'What this request would do changed after it was asked (the item was edited in between). Nothing was written; send the request again.',
          tag: 'Changed',
        }),
      );
    }
    switch (plan.decision._tag) {
      case 'Hidden': {
        return yield* Effect.fail(new AgentNotFoundError({ what: plan.what }));
      }
      case 'Denied': {
        const error = new AgentPermissionDeniedError({
          message: DENIED_MESSAGE[plan.decision.reason],
          reason: plan.decision.reason,
        });
        if (mode === 'direct') {
          yield* logRow(agent, name, plan.summary, {
            error: agentErrorJson(error),
            status: 'blocked',
          });
        }
        return yield* Effect.fail(error);
      }
      case 'Ask': {
        if (mode === 'direct') {
          return yield* requestApproval(agent, name, input, plan.summary);
        }
        return yield* runPlan(plan);
      }
      case 'Allow': {
        if (mode !== 'direct') {
          return yield* runPlan(plan);
        }
        const outcome = yield* Effect.result(runPlan(plan));
        if (outcome._tag === 'Failure') {
          yield* logRow(agent, name, plan.summary, {
            error: agentErrorJson(outcome.failure),
            status: 'failed',
          });
          return yield* Effect.fail(outcome.failure);
        }
        yield* logRow(agent, name, plan.summary, {
          result: outcome.success,
          status: 'done',
        });
        return outcome.success;
      }
    }
  }).pipe(Effect.mapError(toAgentError));

const runRead = (
  agent: AgentRecord,
  name: ToolName,
  input: unknown,
): Effect.Effect<unknown, unknown, GatewayServices> =>
  Effect.gen(function* () {
    if (name === 'get_request') {
      const { requestId } = input as ToolInput<'get_request'>;
      const request = yield* (yield* AgentRequestRepo).get(requestId);
      // Another agent's request is as absent as one that never existed.
      if (!request || request.agentId !== agent.id) {
        return yield* Effect.fail(new AgentNotFoundError({ what: 'Request' }));
      }
      return requestView(request);
    }
    if (name === 'search_contacts') {
      return yield* searchContacts(agent.policy, input as ToolInput<'search_contacts'>);
    }
    const directory = yield* loadDirectory(agent.policy);
    switch (name) {
      case 'list_calendars': {
        return listCalendars(directory);
      }
      case 'list_task_lists': {
        return listTaskLists(directory);
      }
      case 'list_events': {
        return yield* listEvents(directory, input as ToolInput<'list_events'>);
      }
      case 'get_free_busy': {
        return yield* getFreeBusy(directory, input as ToolInput<'get_free_busy'>);
      }
      case 'find_free_slots': {
        return yield* findSlots(directory, input as ToolInput<'find_free_slots'>);
      }
      case 'list_tasks': {
        return yield* listTasks(directory, input as ToolInput<'list_tasks'>);
      }
      default: {
        return yield* Effect.fail(
          new AgentInvalidInputError({ message: `${name} is not a read.` }),
        );
      }
    }
  });

/**
 * The single entry point for an authenticated agent: decode, authorize,
 * run. Everything an agent can do goes through here, for MCP and the CLI
 * alike, and every failure comes out as an AgentError.
 */
export const callTool = (
  agent: AgentRecord,
  name: string,
  rawInput: unknown,
): Effect.Effect<unknown, AgentError, GatewayServices> =>
  Effect.gen(function* () {
    if (!isToolName(name)) {
      return yield* Effect.fail(new AgentInvalidInputError({ message: `Unknown tool "${name}".` }));
    }
    const input = yield* decodeInput(name, rawInput);
    return yield* isWriteTool(name)
      ? executeWrite(agent, name, input, 'direct')
      : runRead(agent, name, input).pipe(Effect.mapError(toAgentError));
  }).pipe(
    Effect.catchDefect((defect) =>
      Effect.fail(new AgentFailedError({ message: formatIssue(defect), tag: 'Defect' })),
    ),
  );

/**
 * The user's answer to a waiting request. Approval is a conditional
 * pending → approved transition, so two clicks (or two windows) execute
 * the write once; whatever happens next, the row ends in done or failed.
 */
export const decideRequest = (
  requestId: string,
  decision: 'approve' | 'deny',
): Effect.Effect<AgentRequestRecord | undefined, never, GatewayServices> =>
  Effect.gen(function* () {
    const requests = yield* AgentRequestRepo;
    const signals = yield* AgentSignals;
    const now = yield* Clock.currentTimeMillis;
    const settledNow = (row: AgentRequestRecord | undefined) =>
      Effect.gen(function* () {
        if (row) {
          yield* signals.settle(requestId);
          yield* signals.publish({ type: 'requests' });
        }
        return row ?? (yield* requests.get(requestId));
      });

    const current = yield* requests.get(requestId);
    if (!current || current.status !== 'pending') {
      return current;
    }
    // Too old to answer: the sweep only runs now and then, the limit holds always.
    if (current.createdAt < now - APPROVAL_TTL_MS) {
      return yield* settledNow(
        yield* requests.transition(requestId, 'pending', 'expired', { finishedAt: now }),
      );
    }
    if (decision === 'deny') {
      return yield* settledNow(
        yield* requests.transition(requestId, 'pending', 'denied', {
          decidedAt: now,
          finishedAt: now,
        }),
      );
    }
    // The stored input goes with the row once it settles, so take it now.
    const approved = yield* requests.transition(requestId, 'pending', 'approved', {
      decidedAt: now,
    });
    if (!approved) {
      return yield* requests.get(requestId);
    }
    yield* signals.publish({ type: 'requests' });
    // From here the row must end in done or failed, whatever goes wrong.
    const outcome = yield* Effect.result(
      Effect.gen(function* () {
        const agent = yield* (yield* AgentRepo).get(approved.agentId);
        if (!agent || !isToolName(approved.tool)) {
          return yield* Effect.fail(
            new AgentFailedError({
              message: 'The agent that asked for this was removed.',
              tag: 'AgentRemoved',
            }),
          );
        }
        const input = yield* decodeInput(approved.tool, approved.input);
        return yield* executeWrite(agent, approved.tool, input, { approved: approved.summary });
      }).pipe(
        Effect.mapError(toAgentError),
        Effect.catchDefect((defect) =>
          Effect.fail(new AgentFailedError({ message: formatIssue(defect), tag: 'Defect' })),
        ),
      ),
    );
    const finishedAt = yield* Clock.currentTimeMillis;
    const settled =
      outcome._tag === 'Success'
        ? yield* requests.transition(requestId, 'approved', 'done', {
            finishedAt,
            result: outcome.success,
          })
        : yield* requests.transition(requestId, 'approved', 'failed', {
            error: agentErrorJson(outcome.failure),
            finishedAt,
          });
    return yield* settledNow(settled);
  }).pipe(
    // Even when the store itself fails, nobody keeps waiting on this request.
    Effect.ensuring(Effect.flatMap(AgentSignals, (signals) => signals.settle(requestId))),
    Effect.catchCause((cause) =>
      Effect.as(Effect.logWarning('agent request decision failed', cause), undefined),
    ),
  );

/**
 * Once at launch: a request the app quit in the middle of executing is
 * failed rather than left "approved" forever. Whether its write landed is
 * unknown, so it is never re-run.
 */
export const recoverInterruptedRequests: Effect.Effect<void, never, AgentRequestRepo> = Effect.gen(
  function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* (yield* AgentRequestRepo).failInterrupted(now, {
      code: 'Failed',
      message:
        'Solunivo quit while this was being written; check the calendar before asking again.',
    });
  },
).pipe(Effect.catchCause((cause) => Effect.logWarning('agent request recovery failed', cause)));

/** Periodic housekeeping: stale requests expire, the log stays bounded. */
export const sweepRequests: Effect.Effect<void, never, AgentRequestRepo | AgentSignals> =
  Effect.gen(function* () {
    const requests = yield* AgentRequestRepo;
    const signals = yield* AgentSignals;
    const now = yield* Clock.currentTimeMillis;
    const expired = yield* requests.expireOlderThan(now - APPROVAL_TTL_MS, now);
    for (const id of expired) {
      yield* signals.settle(id);
    }
    yield* requests.prune(ACTIVITY_LOG_SIZE, BLOCKED_LOG_SIZE);
    if (expired.length > 0) {
      yield* signals.publish({ type: 'requests' });
    }
  }).pipe(Effect.catchCause((cause) => Effect.logWarning('agent request sweep failed', cause)));
