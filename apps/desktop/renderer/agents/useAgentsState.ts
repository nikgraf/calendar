import type { AgentsState } from '@calendar/agent/view';
import { useEffect, useState } from 'react';

/**
 * The agent gateway's state as the main process reports it, refetched on
 * every `agents:changed` push. Agents are a window-level concern (plain
 * preload IPC, like the settings file): grants never cross the rpc seam.
 */
export const useAgentsState = (): AgentsState | null => {
  const [state, setState] = useState<AgentsState | null>(null);
  useEffect(() => {
    let mounted = true;
    const load = () => {
      void window.calendarBridge
        .agentsState()
        .then((next) => {
          if (mounted) {
            setState(next);
          }
        })
        .catch(() => {
          // The section shows nothing rather than a stale or broken state.
        });
    };
    load();
    const unsubscribe = window.calendarBridge.onAgentsChanged(load);
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, []);
  return state;
};
