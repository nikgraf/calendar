import type { AgentsState } from '@calendar/agent/view';
import { useEffect, useState } from 'react';
import { agentsErrorMessage } from './agentActions.ts';

export interface AgentsLoad {
  /** Why the last read failed; null while it succeeds or runs. */
  readonly error: string | null;
  /** Reads again, after a failure. */
  readonly retry: () => void;
  /**
   * The last state read; null until a read succeeded. A failed refresh
   * keeps it (with `error` set): a token shown once must not vanish.
   */
  readonly state: AgentsState | null;
}

/**
 * The agent gateway's state as the main process reports it, refetched on
 * every `agents:changed` push. Agents are a window-level concern (plain
 * preload IPC, like the settings file): grants never cross the rpc seam.
 */
export const useAgentsLoad = (): AgentsLoad => {
  const [state, setState] = useState<AgentsState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let mounted = true;
    const load = () => {
      void window.calendarBridge.agentsState().then(
        (next) => {
          if (mounted) {
            setState(next);
            setError(null);
          }
        },
        (error: unknown) => {
          if (mounted) {
            setError(agentsErrorMessage(error));
          }
        },
      );
    };
    load();
    const unsubscribe = window.calendarBridge.onAgentsChanged(load);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [attempt]);
  return { error, retry: () => setAttempt((count) => count + 1), state };
};

/** The state alone, for views that show nothing without it (the approval dialog). */
export const useAgentsState = (): AgentsState | null => useAgentsLoad().state;
