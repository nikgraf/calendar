import { pendingOpLabel, useGuardedMutations, usePendingOps } from '@calendar/app-state';
import { useState } from 'react';

/** Sidebar indicator for local changes Google has not acknowledged yet. */
export function SyncStatus() {
  const ops = usePendingOps();
  const { discardPendingOp } = useGuardedMutations();
  const [open, setOpen] = useState(false);

  if (ops.length === 0) {
    return null;
  }

  return (
    <div className="mx-3 mb-1 rounded-lg border border-amber-200 bg-amber-50 text-sm">
      <button
        className="w-full px-3 py-2 text-left font-medium text-amber-800"
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        {ops.length} unsynced {ops.length === 1 ? 'change' : 'changes'}
      </button>
      {open ? (
        <ul className="max-h-48 overflow-y-auto border-t border-amber-200">
          {ops.map((op) => {
            const label = pendingOpLabel(op);
            return (
              <li className="flex items-center gap-2 px-3 py-1.5" key={op.id}>
                <span className="min-w-0 flex-1 truncate">
                  {label.text}
                  {label.retry ? (
                    <span className="text-xs text-amber-700"> — {label.retry}</span>
                  ) : null}
                </span>
                <button
                  className="text-xs text-red-600 hover:underline"
                  onClick={() => void discardPendingOp({ opId: op.id })}
                  type="button"
                >
                  Discard
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
