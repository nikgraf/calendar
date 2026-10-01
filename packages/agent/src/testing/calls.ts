import { Effect } from 'effect';
import { expect } from 'vitest';
import type { AgentError } from '../errors.ts';
import type { GatewayServices } from '../gateway.ts';
import { AgentSignals } from '../signals.ts';
import { AgentRequestRepo, type AgentRequestRecord } from '../store.ts';

/** Shared moves of the gateway tests. */

/** The failure of a call that must fail. */
export const failureOf = <A>(effect: Effect.Effect<A, AgentError, GatewayServices>) =>
  Effect.gen(function* () {
    const result = yield* Effect.result(effect);
    if (result._tag !== 'Failure') {
      throw new Error(`expected a failure, got ${JSON.stringify(result.success)}`);
    }
    return result.failure;
  });

export const activity = Effect.gen(function* () {
  return yield* (yield* AgentRequestRepo).list(50);
});

/** Everything `approvalRequested` announced so far. */
export const watchApprovals = Effect.gen(function* () {
  const seen: Array<AgentRequestRecord> = [];
  (yield* AgentSignals).subscribe((change) => {
    if (change.type === 'approvalRequested') {
      seen.push(change.request);
    }
  });
  return seen;
});

/** Lets a forked call run up to the point where it waits for the user. */
export const untilAsked = (seen: ReadonlyArray<AgentRequestRecord>, count = 1) =>
  Effect.gen(function* () {
    for (let spins = 0; spins < 5000 && seen.length < count; spins += 1) {
      yield* Effect.yieldNow;
    }
    expect(seen.length).toBe(count);
    return seen[count - 1]!;
  });
