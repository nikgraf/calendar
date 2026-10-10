import {
  pendingOpLabel,
  useGuardedMutations,
  usePendingOps,
  useSyncStatus,
  useTimeZones,
} from '@calendar/app-state';
import { describeConflict, isParkedOp, type PendingOpSummary } from '@calendar/core';
import { useState } from 'react';
import { IconButton } from '../../ui/IconButton.tsx';
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloudUpIcon,
  SlidersIcon,
} from '../../ui/icons.tsx';
import { ConflictActions } from '../ConflictBanner.tsx';

/** One field of a change: what it was (struck through) and what it becomes. */
interface DetailLine {
  readonly after: string | null;
  readonly before: string | null;
  readonly label: string;
}

/**
 * What an expanded row shows: a parked change as "yours" and "Google's"
 * per field (the banner's words), any other as before → after.
 */
const detailLines = (op: PendingOpSummary, timeZone: string): ReadonlyArray<DetailLine> =>
  isParkedOp(op)
    ? describeConflict(op, timeZone).changes.flatMap((change) => [
        { after: change.mine, before: null, label: `${change.label} (yours)` },
        { after: change.theirs, before: null, label: `${change.label} (Google’s)` },
      ])
    : (op.diff ?? []);

/** The lines of one change, stacked: the sidebar is too narrow for columns. */
function PendingOpDetail({ op, timeZone }: { op: PendingOpSummary; timeZone: string }) {
  const lines = detailLines(op, timeZone);
  if (lines.length === 0) {
    return (
      <p className="text-xs text-ink-secondary">
        {op.diff === undefined && !isParkedOp(op)
          ? 'No details for this change.'
          : 'No visible difference.'}
      </p>
    );
  }
  return (
    <dl className="flex flex-col gap-1.5 text-xs">
      {lines.map((line, index) => (
        <div key={`${line.label}-${String(index)}`}>
          <dt className="text-ink-secondary">{line.label}</dt>
          {line.before === null ? null : (
            <dd>
              <del className="break-words text-ink-secondary">{line.before}</del>
            </dd>
          )}
          {line.after === null ? null : (
            <dd>
              <ins className="break-words no-underline">{line.after}</ins>
            </dd>
          )}
        </div>
      ))}
    </dl>
  );
}

/**
 * The sidebar's foot: what sync is up to — importing, all synced, or the
 * changes Google has not acknowledged yet — and the way to Settings. The
 * list's rows expand to what each change does, field by field, with the
 * way to discard it (which puts the item back as it was) or, for a
 * conflict, the choice between the two versions.
 */
export function SyncFooter({ onManageAccounts }: { onManageAccounts: () => void }) {
  const ops = usePendingOps();
  const importing = useSyncStatus().some((account) => account.importing);
  const { discardPendingOp } = useGuardedMutations();
  const { primary: timeZone } = useTimeZones();
  const [open, setOpen] = useState(false);
  const [expandedId, setExpandedId] = useState<string | null>(null);

  return (
    <div className="flex shrink-0 flex-col border-t border-hairline" data-testid="sync-footer">
      {open && ops.length > 0 ? (
        <ul className="max-h-80 overflow-y-auto border-b border-hairline text-sm">
          {ops.map((op) => {
            const label = pendingOpLabel(op);
            const expanded = expandedId === op.id;
            return (
              <li className="border-b border-hairline last:border-b-0" key={op.id}>
                <button
                  aria-expanded={expanded}
                  className="flex w-full items-center gap-1.5 px-2 py-1.5 text-left hover:bg-fill"
                  data-testid={`pending-op-${op.id}`}
                  onClick={() => setExpandedId(expanded ? null : op.id)}
                  type="button"
                >
                  {expanded ? (
                    <ChevronDownIcon className="shrink-0 text-ink-secondary" size={12} />
                  ) : (
                    <ChevronRightIcon className="shrink-0 text-ink-secondary" size={12} />
                  )}
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
                </button>
                {expanded ? (
                  <div
                    className="flex flex-col gap-2 px-3 pb-2 pl-7"
                    data-testid="pending-op-change"
                  >
                    <PendingOpDetail op={op} timeZone={timeZone} />
                    <div className="flex justify-end">
                      {isParkedOp(op) ? (
                        <ConflictActions op={op} size="sm" />
                      ) : (
                        <button
                          className="text-xs text-danger hover:underline"
                          data-testid="pending-op-discard"
                          onClick={() => {
                            setExpandedId(null);
                            void discardPendingOp({ opId: op.id });
                          }}
                          type="button"
                        >
                          Discard change
                        </button>
                      )}
                    </div>
                  </div>
                ) : null}
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
