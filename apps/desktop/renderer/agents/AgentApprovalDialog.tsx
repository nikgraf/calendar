import { useState } from 'react';
import { Dialog } from '../Dialog.tsx';
import { useAgentsState } from './useAgentsState.ts';

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
  const [busy, setBusy] = useState(false);

  const waiting = (state?.pending ?? []).filter((request) => !dismissed.includes(request.id));
  const request = waiting[0];
  if (!request) {
    return null;
  }

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
    <Dialog
      // One dialog instance per request, so focus lands on its own buttons.
      key={request.id}
      label="Agent request"
      onClose={() => setDismissed([...dismissed, request.id])}
      panelClassName="w-[28rem] rounded-2xl bg-white p-5 shadow-xl"
      zIndex={50}
    >
      <div data-testid="agent-approval">
        <p className="text-xs font-medium tracking-wide text-neutral-500 uppercase">
          {request.agentName} is asking
          {waiting.length > 1 ? ` · 1 of ${waiting.length}` : ''}
        </p>
        <h3 className="mt-1 font-medium" data-testid="agent-approval-title">
          {request.summary.title}
        </h3>
        <ul className="mt-2 space-y-1 text-sm text-neutral-700 select-text">
          {request.summary.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <div className="mt-4 flex justify-end gap-2">
          <button
            className="rounded-lg px-3 py-1.5 text-sm text-neutral-600 hover:bg-neutral-100"
            onClick={() => setDismissed([...dismissed, request.id])}
            type="button"
          >
            Later
          </button>
          <button
            className="rounded-lg border border-neutral-300 px-3 py-1.5 text-sm hover:bg-neutral-50 disabled:opacity-50"
            data-testid="agent-deny"
            disabled={busy}
            onClick={() => void decide('deny')}
            type="button"
          >
            Decline
          </button>
          <button
            className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
            data-testid="agent-approve"
            disabled={busy}
            onClick={() => void decide('approve')}
            type="button"
          >
            Approve
          </button>
        </div>
      </div>
    </Dialog>
  );
}
