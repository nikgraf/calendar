import {
  pendingOpLabel,
  useGuardedMutations,
  usePendingOps,
  useSyncStatus,
} from '@calendar/app-state';
import { isParkedOp } from '@calendar/core';
import { useState } from 'react';
import { IconButton } from '../../ui/IconButton.tsx';
import { CheckIcon, CloudUpIcon, SlidersIcon } from '../../ui/icons.tsx';
import { ConflictActions } from '../ConflictBanner.tsx';

/**
 * The sidebar's foot: what sync is up to — importing, all synced, or the
 * changes Google has not acknowledged yet (expanding to the list with
 * Discard / conflict choices) — and the way to Settings.
 */
export function SyncFooter({ onManageAccounts }: { onManageAccounts: () => void }) {
  const ops = usePendingOps();
  const importing = useSyncStatus().some((account) => account.importing);
  const { discardPendingOp } = useGuardedMutations();
  const [open, setOpen] = useState(false);

  return (
    <div className="flex shrink-0 flex-col border-t border-hairline" data-testid="sync-footer">
      {open && ops.length > 0 ? (
        <ul className="max-h-48 overflow-y-auto border-b border-hairline text-sm">
          {ops.map((op) => {
            const label = pendingOpLabel(op);
            return (
              <li className="flex items-center gap-2 px-3 py-1.5" key={op.id}>
                <span className="min-w-0 flex-1">
                  <span className="block truncate">
                    {label.text}
                    {label.retry ? (
                      <span className="text-xs text-warning"> — {label.retry}</span>
                    ) : null}
                  </span>
                  {label.reason ? (
                    <span
                      className="block truncate text-xs text-ink-secondary"
                      data-testid="pending-op-reason"
                      title={label.reason}
                    >
                      {label.reason}
                    </span>
                  ) : null}
                </span>
                {isParkedOp(op) ? (
                  <ConflictActions op={op} size="sm" />
                ) : (
                  <button
                    className="text-xs text-danger hover:underline"
                    onClick={() => void discardPendingOp({ opId: op.id })}
                    type="button"
                  >
                    Discard
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      ) : null}
      <div className="flex h-11 items-center justify-between gap-2 pr-2 pl-4">
        {ops.length > 0 ? (
          <button
            className="flex min-w-0 items-center gap-1.5 text-xs font-medium text-warning"
            onClick={() => setOpen((current) => !current)}
            type="button"
          >
            <CloudUpIcon size={14} />
            <span className="truncate">
              {ops.length} unsynced {ops.length === 1 ? 'change' : 'changes'}
            </span>
          </button>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 text-xs text-ink-secondary">
            {importing ? (
              <>
                <CloudUpIcon className="shrink-0" size={14} />
                <span className="truncate">Importing…</span>
              </>
            ) : (
              <>
                <CheckIcon className="shrink-0 text-success" size={14} />
                <span className="truncate">All changes synced</span>
              </>
            )}
          </span>
        )}
        <IconButton label="Manage accounts…" onClick={onManageAccounts} size="sm">
          <SlidersIcon size={15} />
          {/* The name stays in the text too: the e2e suite finds buttons by it. */}
          <span className="sr-only">Manage accounts…</span>
        </IconButton>
      </div>
    </div>
  );
}
