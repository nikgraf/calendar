import type { Effect } from 'effect';
import type { WriteDecision } from '../policy.ts';
import type { RequestSummary } from '../store.ts';

/** What a finished write answers with. */
export type WriteResult = { readonly status: 'done' } & Readonly<Record<string, unknown>>;

/**
 * A write, fully checked but not yet executed: the resolved target, the
 * policy's verdict on it, the text the user would approve, and the effect
 * that performs it. Planning is repeated from the stored input when a
 * request is approved, so a grant that changed in between still applies.
 */
export interface WritePlan<R> {
  readonly decision: WriteDecision;
  readonly run: Effect.Effect<WriteResult, unknown, R>;
  readonly summary: RequestSummary;
  /** What the target is called in a "not found" answer. */
  readonly what: string;
}
