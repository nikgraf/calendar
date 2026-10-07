import type { AgentRequestView } from '@calendar/agent/view';
import { useEffect, useState } from 'react';
import { Dialog } from '../Dialog.tsx';
import { useAgentsState } from './useAgentsState.ts';

/** A request's buttons stay inert this long after it appears. */
export const ARM_DELAY_MS = 700;

/**
 * One waiting request. Mounted fresh per request (keyed by its id), so
 * the buttons start disarmed every time: when one request is answered
 * and the next takes its place, a second click meant for the first
 * cannot approve the one nobody has read yet.
 */
function ApprovalPanel({
  onLater,
  request,
  waiting,
}: {
  onLater: () => void;
  request: AgentRequestView;
  waiting: number;
}) {
  const [armed, setArmed] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setArmed(true), ARM_DELAY_MS);
    return () => clearTimeout(timer);
  }, []);

  const decide = async (decision: 'approve' | 'deny') => {
    setBusy(true);
    try {
      await window.calendarBridge.agentsDecide(request.id, decision);
    } catch {
      // The request stays pending and visible; the user can answer again.
    } finally {
      setBusy(false);
    }
  };

  return (
    <div data-testid="agent-approval">
      <p className="text-xs font-medium tracking-wide text-ink-secondary uppercase">
        {request.agentName} is asking
        {waiting > 1 ? ` · 1 of ${waiting}` : ''}
      </p>
      <h3 className="mt-1 font-medium break-words" data-testid="agent-approval-title">
        {request.summary.title}
      </h3>
      {/* Everything that will be written is here in full — long text scrolls, it is never cut. */}
      <ul className="mt-2 max-h-[50vh] space-y-1 overflow-y-auto text-sm break-words text-ink-secondary select-text">
        {request.summary.lines.map((line) => (
          <li key={line}>{line}</li>
        ))}
      </ul>
      <div className="mt-4 flex justify-end gap-2">
        <button
          className="rounded-lg px-3 py-1.5 text-sm text-ink-secondary hover:bg-fill"
          onClick={onLater}
          type="button"
        >
          Later
        </button>
        <button
          className="rounded-lg border border-hairline-strong px-3 py-1.5 text-sm hover:bg-surface-subtle disabled:opacity-50"
          data-testid="agent-deny"
          disabled={busy || !armed}
          onClick={() => void decide('deny')}
          type="button"
        >
          Decline
        </button>
        <button
          className="rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          data-testid="agent-approve"
          disabled={busy || !armed}
          onClick={() => void decide('approve')}
          type="button"
        >
          Approve
        </button>
      </div>
    </div>
  );
}

/**
 * The "ask me first" prompt: whenever an agent's write is waiting, the
 * window shows what the app is about to do — text the app wrote from the
 * resolved request, never the agent's own description — and takes the
 * answer. Dismissing it decides nothing; the request stays listed under
 * Settings → Agents until it is answered or expires.
 */
export function AgentApprovalDialog() {
  const state = useAgentsState();
  const [dismissed, setDismissed] = useState<ReadonlyArray<string>>([]);

  const waiting = (state?.pending ?? []).filter((request) => !dismissed.includes(request.id));
  const request = waiting[0];
  if (!request) {
    return null;
  }
  const later = () => setDismissed([...dismissed, request.id]);

  return (
    <Dialog
      key={request.id}
      label="Agent request"
      onClose={later}
      panelClassName="w-[30rem] rounded-2xl bg-surface p-5 shadow-xl"
      zIndex={50}
    >
      <ApprovalPanel onLater={later} request={request} waiting={waiting.length} />
    </Dialog>
  );
}
