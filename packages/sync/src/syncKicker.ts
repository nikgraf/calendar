/** Minimum spacing between two kicks; syncAll is serialized anyway. */
const DEFAULT_MIN_INTERVAL_MS = 15_000;

/**
 * A debounced "sync now" for the moments staleness is most visible —
 * wake, unlock, refocus, foreground — which the steady-state poll
 * misses. `run` starts one sync pass; its failures are the engine's to
 * log and the regular schedule's to retry, so they are swallowed here.
 * Both apps carried this block verbatim.
 */
export const makeSyncKicker = (
  run: () => Promise<void>,
  minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
): (() => void) => {
  let lastKickAt = 0;
  return () => {
    const now = Date.now();
    if (now - lastKickAt < minIntervalMs) {
      return;
    }
    lastKickAt = now;
    run().catch(() => {
      // Transient failures are retried by the regular schedule.
    });
  };
};
