import { describeConflict, type ParkedOpSummary } from '@calendar/core';
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { type MutationNotice, subscribeMutationNotices } from './mutationGuard.ts';

/**
 * How long a transient notice — a failed write, a change Google discarded —
 * stays on screen. The conflict banner is not transient: it stays until
 * the change is resolved.
 */
export const NOTICE_MS = 6000;

/** The toast for a queued change Google permanently rejected (a 4xx the queue dropped). */
export const DROPPED_NOTICE_TEXT = 'Google rejected a change and it was discarded.';

/** A failed write's toast, first line; the notice's detail is the second. */
export const mutationNoticeText = (notice: MutationNotice): string =>
  `Couldn’t ${notice.action} — the change was not applied.`;

/** A transient notice on screen, with the number of the publish that raised it. */
export interface ShownNotice<T> {
  readonly id: number;
  readonly value: T;
}

/**
 * The latest failed write, gone NOTICE_MS after it arrived; a newer one
 * replaces it and starts the clock again. The same refusal published twice
 * comes back with a new id, so a toast keyed by it mounts (and is
 * announced) again.
 */
export const useMutationNotice = (): ShownNotice<MutationNotice> | null => {
  const [shown, setShown] = useState<ShownNotice<MutationNotice> | null>(null);
  useEffect(() => subscribeMutationNotices((value, id) => setShown({ id, value })), []);
  useEffect(() => {
    if (!shown) {
      return;
    }
    const timer = setTimeout(() => setShown(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [shown]);
  return shown;
};

let broadcasts = 0;

/**
 * A notice raised by a broadcast invalidation key (the dropped-change
 * toast): a number while it is on screen — a new one per broadcast — and
 * null NOTICE_MS after the latest.
 */
export const useBroadcastNotice = (
  subscribe: (listener: (keys: ReadonlyArray<unknown>) => void) => () => void,
  key: string,
): number | null => {
  const [shown, setShown] = useState<number | null>(null);
  useEffect(
    () =>
      subscribe((keys) => {
        if (keys.includes(key)) {
          broadcasts += 1;
          setShown(broadcasts);
        }
      }),
    [key, subscribe],
  );
  useEffect(() => {
    if (shown === null) {
      return;
    }
    const timer = setTimeout(() => setShown(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [shown]);
  return shown;
};

/**
 * Parked changes a screen reader has not been told about yet. `told` holds
 * the ids already announced that are still parked; a change that leaves the
 * queue is forgotten, so the set never outgrows the queue.
 */
export const freshConflicts = (
  told: ReadonlySet<string>,
  parked: ReadonlyArray<ParkedOpSummary>,
): { readonly fresh: ReadonlyArray<ParkedOpSummary>; readonly told: ReadonlySet<string> } => ({
  fresh: parked.filter((op) => !told.has(op.id)),
  told: new Set(parked.map((op) => op.id)),
});

/**
 * What a screen reader hears when changes park: the first new one's
 * headline, as the banner and the conflict alert word it, and how many more
 * arrived with it. Undefined when nothing is new.
 */
export const conflictAnnouncement = (
  fresh: ReadonlyArray<ParkedOpSummary>,
  timeZone: string,
): string | undefined => {
  const first = fresh[0];
  if (!first) {
    return undefined;
  }
  const { headline } = describeConflict(first, timeZone);
  const more = fresh.length - 1;
  return more === 0
    ? `Sync conflict: ${headline}`
    : `Sync conflict: ${headline} ${String(more)} more ${more === 1 ? 'change also conflicts' : 'changes also conflict'}.`;
};

/**
 * Tells a screen reader about each change that parks, once: on mount for
 * what is already parked, then whenever a new one joins the queue — never
 * for a re-render of the same queue, nor for a change being resolved.
 */
export const useConflictAnnouncement = (
  parked: ReadonlyArray<ParkedOpSummary>,
  timeZone: string,
  announce: (text: string) => void,
): void => {
  const told = useRef<ReadonlySet<string>>(new Set());
  const update = useEffectEvent(() => {
    const next = freshConflicts(told.current, parked);
    told.current = next.told;
    const text = conflictAnnouncement(next.fresh, timeZone);
    if (text !== undefined) {
      announce(text);
    }
  });
  const ids = parked.map((op) => op.id).join('\n');
  useEffect(() => update(), [ids]);
};
