/** What the pane asks before an agent action that cannot be undone. */
export type AgentAction = 'remove' | 'rotate';

export interface AgentActionQuestion {
  readonly confirm: string;
  readonly detail: string;
  readonly title: string;
}

const waitingClause = (waiting: number): string =>
  waiting === 0
    ? ''
    : waiting === 1
      ? ' Its request waiting for you is cancelled.'
      : ` Its ${waiting} requests waiting for you are cancelled.`;

/**
 * The confirmation for replacing an agent's token or removing the agent:
 * both cut a connected agent off at once, and neither comes back.
 */
export const agentActionQuestion = (
  action: AgentAction,
  name: string,
  waiting: number,
): AgentActionQuestion =>
  action === 'rotate'
    ? {
        confirm: 'Replace token',
        detail: `The current token stops working now: ${name} cannot connect until you give it the new one.`,
        title: `Replace the token for “${name}”?`,
      }
    : {
        confirm: 'Remove',
        detail: `Its token stops working now and its access is deleted.${waitingClause(waiting)} Adding it again needs a new token and new access.`,
        title: `Remove “${name}”?`,
      };

/**
 * An `agents:*` failure as the pane shows it: Electron wraps a handler's
 * error in "Error invoking remote method 'agents:state': Error: …".
 */
export const agentsErrorMessage = (error: unknown): string => {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*': (?:\w*Error: )?/u, '');
};
