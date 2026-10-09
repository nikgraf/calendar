import {
  NOTICE_MS,
  useConflictAnnouncement,
  useGuardedMutations,
  usePendingOps,
  useTimeZones,
} from '@calendar/app-state';
import {
  conflictChoiceLabels,
  describeConflict,
  isParkedOp,
  type ParkedOpSummary,
} from '@calendar/core';
import { useEffect, useId, useState } from 'react';
import { makeAnnouncer } from '../announcer.ts';
import { CALLOUT_CLASS } from '../ui/calloutStyles.ts';

/** Keep-mine / take-theirs for one parked op (the banner and the queue panel). */
export function ConflictActions({ op, size = 'md' }: { op: ParkedOpSummary; size?: 'md' | 'sm' }) {
  const { resolveConflict } = useGuardedMutations();
  const labels = conflictChoiceLabels(op);
  const padding = size === 'sm' ? 'px-2 py-0.5 text-xs' : 'px-3 py-1';
  return (
    <div className="flex shrink-0 gap-2">
      <button
        className={`rounded-control ${padding} text-ink hover:bg-fill`}
        onClick={() => void resolveConflict({ choice: 'theirs', opId: op.id })}
        type="button"
      >
        {labels.theirs}
      </button>
      <button
        className={`rounded-control bg-primary ${padding} font-medium text-on-primary hover:bg-primary-hover`}
        onClick={() => void resolveConflict({ choice: 'mine', opId: op.id })}
        type="button"
      >
        {labels.mine}
      </button>
    </div>
  );
}

/**
 * How long a conflict's announcement waits before it reaches its live
 * region. The region mounts empty with the notice stack; a screen reader
 * needs a beat to register it before the words it should read arrive.
 * Conflicts that park meanwhile are told with it (`makeAnnouncer`).
 */
const ANNOUNCE_DELAY_MS = 100;

/**
 * A queued change Google refused with a 412 (the event changed there
 * first): names the event, shows what differs, and stays until the user
 * keeps their version or takes Google's. Parked ops never retry, so a
 * transient toast would let the change sit unnoticed.
 *
 * A labelled region — not an alertdialog, which promises a dialog that
 * takes focus, while the banner leaves focus where it is and the calendar
 * usable; and not a live region, which would read its table and buttons
 * again on every change. Each change that parks is told once instead,
 * through a polite status region always mounted beside the banner.
 */
export function ConflictBanner() {
  const parked = usePendingOps().filter(isParkedOp);
  const { primary: timeZone } = useTimeZones();
  const headlineId = useId();
  // Numbered, so the same words told twice are a new node the region reads again.
  const [news, setNews] = useState<{ readonly id: number; readonly text: string } | null>(null);
  const [announcer] = useState(() =>
    makeAnnouncer(ANNOUNCE_DELAY_MS, (texts) =>
      setNews((current) => ({ id: (current?.id ?? 0) + 1, text: texts.join(' ') })),
    ),
  );
  useEffect(() => announcer.stop, [announcer]);
  useConflictAnnouncement(parked, timeZone, announcer.say);
  // Cleared once read, so the words do not linger in the reading order.
  useEffect(() => {
    if (news === null) {
      return;
    }
    const timer = setTimeout(() => setNews(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [news]);

  const first = parked[0];
  const description = first ? describeConflict(first, timeZone) : null;
  return (
    <>
      <div className="sr-only" data-testid="conflict-status" role="status">
        {news ? <span key={news.id}>{news.text}</span> : null}
      </div>
      {first && description ? (
        <section
          aria-labelledby={headlineId}
          className={`${CALLOUT_CLASS.warning} pointer-events-auto mb-2 w-full max-w-[34rem] p-3 text-sm shadow-lg`}
          data-testid="conflict-banner"
        >
          <h2 className="font-medium break-words" id={headlineId}>
            {description.headline}
          </h2>
          {description.changes.length > 0 ? (
            <table className="mt-2 w-full table-fixed text-left text-xs">
              <colgroup>
                <col className="w-18" />
                <col />
                <col />
              </colgroup>
              <thead>
                <tr>
                  <td />
                  <th className="pr-3 pb-1 font-medium" scope="col">
                    Yours
                  </th>
                  <th className="pb-1 font-medium" scope="col">
                    Google&rsquo;s
                  </th>
                </tr>
              </thead>
              <tbody>
                {description.changes.map((change) => (
                  <tr className="align-top" key={change.label}>
                    <th className="pr-3 pb-1 font-normal text-ink-secondary" scope="row">
                      {change.label}
                    </th>
                    <td className="pr-3 pb-1 break-words">{change.mine}</td>
                    <td className="pb-1 break-words">{change.theirs}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-ink-secondary">
              {parked.length > 1 ? `+${String(parked.length - 1)} more in unsynced changes` : ''}
            </span>
            <ConflictActions op={first} />
          </div>
        </section>
      ) : null}
    </>
  );
}
