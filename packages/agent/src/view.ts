import type { AgentErrorJson } from './errors.ts';
import type { AgentPolicy } from './policy.ts';
import type { RelayCommand } from './policyEdit.ts';
import type { AgentRequestRecord, RequestStatus, RequestSummary } from './store.ts';

/**
 * What the Settings UI is shown. Types only: the renderer imports this
 * file (and policy.ts) and nothing else of the package.
 */

export interface AgentView {
  readonly createdAt: number;
  readonly id: string;
  readonly lastUsedAt?: number;
  readonly name: string;
  readonly policy: AgentPolicy;
}

/** A request without its raw input: the UI shows the app-written summary only. */
export interface AgentRequestView {
  readonly agentId: string;
  readonly agentName: string;
  readonly createdAt: number;
  readonly decidedAt?: number;
  readonly error?: AgentErrorJson;
  readonly finishedAt?: number;
  readonly id: string;
  readonly status: RequestStatus;
  readonly summary: RequestSummary;
  readonly tool: string;
}

export interface AgentsState {
  /** Finished requests, newest first. */
  readonly activity: ReadonlyArray<AgentRequestView>;
  readonly agents: ReadonlyArray<AgentView>;
  /** How an agent starts the relay on this Mac (for the copyable config). */
  readonly command: RelayCommand;
  /** Why the gateway is not listening although agents exist. */
  readonly error?: string;
  readonly listening: boolean;
  /** Writes waiting for the user's answer, oldest first. */
  readonly pending: ReadonlyArray<AgentRequestView>;
  readonly socketPath: string;
}

export const toRequestView = (request: AgentRequestRecord): AgentRequestView => ({
  agentId: request.agentId,
  agentName: request.agentName,
  createdAt: request.createdAt,
  ...(request.decidedAt === undefined ? {} : { decidedAt: request.decidedAt }),
  ...(request.error === undefined ? {} : { error: request.error }),
  ...(request.finishedAt === undefined ? {} : { finishedAt: request.finishedAt }),
  id: request.id,
  status: request.status,
  summary: request.summary,
  tool: request.tool,
});
