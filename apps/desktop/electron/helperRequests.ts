export const HELPER_TIMED_OUT = 'model helper timed out';

/** How long the liveness probe after a timeout may take before the helper counts as wedged. */
export const PROBE_TIMEOUT_MS = 5000;

interface PendingRequest {
  readonly reject: (error: Error) => void;
  readonly resolve: (value: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface HelperRequests {
  /** Sends one request; it settles with the helper's answer or its own timeout. */
  readonly call: (method: string, params?: Record<string, unknown>) => Promise<unknown>;
  /** Fails every request still waiting (the helper exited). */
  readonly failAll: (message: string) => void;
  /**
   * Takes one line of the helper's stdout: an answer settles its request.
   * Returns the name of an unsolicited `{"event": name}` line.
   */
  readonly receive: (line: string) => string | undefined;
}

/**
 * The requests in flight to one helper process (newline-delimited JSON:
 * {id,method,params} → {id,result|error}).
 *
 * A timeout fails that request alone. The helper runs every request in its
 * own task, so one slow call (a MapKit search on a bad network) says
 * nothing about the others; killing the helper for it used to fail them
 * all, a pending permission prompt or transcription included. Instead a
 * `status` probe asks whether the helper still answers, and only a probe
 * that times out too kills it — the next call then respawns it.
 */
export const makeHelperRequests = (options: {
  readonly kill: () => void;
  readonly timeoutFor: (method: string) => number;
  readonly write: (line: string) => void;
}): HelperRequests => {
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let probing = false;

  const send = (
    method: string,
    params: Record<string, unknown> | undefined,
    timeoutMs: number,
    onTimeout: () => void,
  ): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(HELPER_TIMED_OUT));
        onTimeout();
      }, timeoutMs);
      pending.set(id, { reject, resolve, timer });
      options.write(`${JSON.stringify({ id, method, ...(params ? { params } : {}) })}\n`);
    });
  };

  const probe = () => {
    if (probing) {
      return;
    }
    probing = true;
    // Any answer, an error included, means the helper still reads stdin.
    void send('status', undefined, PROBE_TIMEOUT_MS, options.kill)
      .catch(() => undefined)
      .finally(() => {
        probing = false;
      });
  };

  return {
    call: (method, params) => send(method, params, options.timeoutFor(method), probe),
    failAll: (message) => {
      for (const [, request] of pending) {
        clearTimeout(request.timer);
        request.reject(new Error(message));
      }
      pending.clear();
    },
    receive: (line) => {
      let parsed: { error?: string; event?: string; id?: number; result?: unknown };
      try {
        parsed = JSON.parse(line) as typeof parsed;
      } catch {
        return undefined;
      }
      if (parsed.id === undefined) {
        return typeof parsed.event === 'string' ? parsed.event : undefined;
      }
      const request = pending.get(parsed.id);
      if (!request) {
        return undefined;
      }
      pending.delete(parsed.id);
      clearTimeout(request.timer);
      if (parsed.error === undefined) {
        request.resolve(parsed.result);
      } else {
        request.reject(new Error(parsed.error));
      }
      return undefined;
    },
  };
};
