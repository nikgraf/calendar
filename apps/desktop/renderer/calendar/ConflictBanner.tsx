import { useGuardedMutations, usePendingOps } from '@calendar/app-state';
import {
  conflictChoiceLabels,
  describeConflict,
  isParkedOp,
  type ParkedOpSummary,
  Temporal,
} from '@calendar/core';

/** Keep-mine / take-theirs for one parked op (the banner and the queue panel). */
export function ConflictActions({ op, size = 'md' }: { op: ParkedOpSummary; size?: 'md' | 'sm' }) {
  const { resolveConflict } = useGuardedMutations();
  const labels = conflictChoiceLabels(op);
  const padding = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1';
  return (
    <div className="flex shrink-0 gap-2">
      <button
        className={`rounded-lg ${padding} hover:bg-amber-100`}
        onClick={() => void resolveConflict({ choice: 'theirs', opId: op.id })}
        type="button"
      >
        {labels.theirs}
      </button>
      <button
        className={`rounded-lg bg-amber-600 ${padding} font-medium text-white hover:bg-amber-500`}
        onClick={() => void resolveConflict({ choice: 'mine', opId: op.id })}
        type="button"
      >
        {labels.mine}
      </button>
    </div>
  );
}

/**
 * A queued change Google refused with a 412 (the event changed there
 * first): names the event, shows what differs, and stays until the user
 * keeps their version or takes Google's. Parked ops never retry, so a
 * transient toast would let the change sit unnoticed.
 */
export function ConflictBanner() {
  const parked = usePendingOps().filter(isParkedOp);
  const first = parked[0];
  if (!first) {
    return null;
  }
  const { changes, headline } = describeConflict(first, Temporal.Now.timeZoneId());
  return (
    <div
      className="fixed bottom-4 left-1/2 z-40 w-[min(34rem,calc(100vw-2rem))] -translate-x-1/2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900 shadow-lg"
      data-testid="conflict-banner"
      role="alertdialog"
    >
      <p className="font-medium">{headline}</p>
      {changes.length > 0 ? (
        <dl className="mt-2 grid grid-cols-[auto_1fr_1fr] gap-x-3 gap-y-1 text-xs">
          <dt />
          <dd className="font-medium">Yours</dd>
          <dd className="font-medium">Google&rsquo;s</dd>
          {changes.map((change) => (
            <div className="contents" key={change.label}>
              <dt className="text-amber-700">{change.label}</dt>
              <dd className="break-words">{change.mine}</dd>
              <dd className="break-words">{change.theirs}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-xs text-amber-700">
          {parked.length > 1 ? `+${String(parked.length - 1)} more in unsynced changes` : ''}
        </span>
        <ConflictActions op={first} />
      </div>
    </div>
  );
}
