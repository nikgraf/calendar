import { Context, Deferred, Effect, Layer } from 'effect';
import type { AgentRequestRecord } from './store.ts';

/** What the host repaints or announces on. */
export type AgentChange =
  /** An agent was added, changed or removed. */
  | { readonly type: 'agents' }
  /** A write is waiting for the user: notify, badge, show the dialog. */
  | { readonly request: AgentRequestRecord; readonly type: 'approvalRequested' }
  /** The request list changed (a write landed, an approval settled, …). */
  | { readonly type: 'requests' };

export interface AgentSignalsShape {
  /** Completes when the request settles, or after `timeoutMs` — whichever is first. */
  readonly awaitSettled: (requestId: string, timeoutMs: number) => Effect.Effect<void>;
  readonly publish: (change: AgentChange) => Effect.Effect<void>;
  /** Wakes every call waiting on the request. */
  readonly settle: (requestId: string) => Effect.Effect<void>;
  readonly subscribe: (listener: (change: AgentChange) => void) => () => void;
}

/**
 * In-memory glue between an agent's waiting call, the user's decision and
 * the host. Nothing here is durable: the request row is the truth, and a
 * waiter that misses its wake-up just reads the row on its next poll.
 */
export const makeAgentSignals = (): AgentSignalsShape => {
  const waiters = new Map<string, Deferred.Deferred<void>>();
  const listeners = new Set<(change: AgentChange) => void>();
  return {
    awaitSettled: (requestId, timeoutMs) =>
      Effect.gen(function* () {
        let deferred = waiters.get(requestId);
        if (!deferred) {
          deferred = Deferred.makeUnsafe<void>();
          waiters.set(requestId, deferred);
        }
        yield* Deferred.await(deferred).pipe(Effect.timeoutOption(timeoutMs));
      }),
    publish: (change) =>
      Effect.sync(() => {
        for (const listener of listeners) {
          try {
            listener(change);
          } catch {
            // A broken listener must not fail the write that triggered it.
          }
        }
      }),
    settle: (requestId) =>
      Effect.sync(() => {
        const deferred = waiters.get(requestId);
        if (deferred) {
          waiters.delete(requestId);
          Deferred.doneUnsafe(deferred, Effect.void);
        }
      }),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
};

export class AgentSignals extends Context.Service<AgentSignals, AgentSignalsShape>()(
  'agent/AgentSignals',
) {
  static readonly layer: Layer.Layer<AgentSignals> = Layer.sync(AgentSignals)(makeAgentSignals);
}
