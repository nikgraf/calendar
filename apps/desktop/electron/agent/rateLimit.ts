/**
 * A sliding-window limit per agent. Not a security boundary — a runaway
 * loop in an agent should not be able to keep the main thread busy
 * expanding recurrences.
 */
export const makeRateLimiter = (
  limit: number,
  windowMs: number,
  now: () => number = Date.now,
): { readonly take: (key: string) => boolean } => {
  const calls = new Map<string, Array<number>>();
  return {
    take: (key) => {
      const cutoff = now() - windowMs;
      const recent = (calls.get(key) ?? []).filter((at) => at > cutoff);
      if (recent.length >= limit) {
        calls.set(key, recent);
        return false;
      }
      recent.push(now());
      calls.set(key, recent);
      return true;
    },
  };
};
