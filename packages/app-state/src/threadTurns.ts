import { useEffect, useState } from 'react';

/**
 * How a thread's turns are listed — the create thread's and the search
 * thread's alike, on both apps: newest first, at most `TURNS_SHOWN`
 * until the list is expanded, the rest counted under them
 * ("+2 earlier queries").
 */

/** The turns a collapsed list shows. */
export const TURNS_SHOWN = 3;

/** The turns to draw, newest first, and how many older ones the collapsed list leaves out. */
export const visibleTurns = <T>(
  turns: ReadonlyArray<T>,
  expanded: boolean,
): { readonly hidden: number; readonly shown: ReadonlyArray<T> } => {
  const newestFirst = [...turns].reverse();
  return expanded || newestFirst.length <= TURNS_SHOWN
    ? { hidden: 0, shown: newestFirst }
    : { hidden: newestFirst.length - TURNS_SHOWN, shown: newestFirst.slice(0, TURNS_SHOWN) };
};

/** The control under a collapsed list: "+1 earlier query", "+4 earlier queries". */
export const earlierTurnsLabel = (hidden: number): string =>
  `+${String(hidden)} earlier ${hidden === 1 ? 'query' : 'queries'}`;

/** How long a changed field or chip stays tinted after a turn lands, fading back to its own color. */
export const TURN_FLASH_MS = 1100;

/**
 * A turn's flash while it plays, then nothing: a field or chip that
 * mounts later (a time field shown again, a filter re-added) must not
 * flash for a turn long past. `key` names the turn.
 */
export const useFleetingFlash = <T extends { readonly key: string }>(flash: T | null): T | null => {
  const [spent, setSpent] = useState<string | null>(null);
  const key = flash?.key ?? null;
  useEffect(() => {
    if (key === null) {
      return undefined;
    }
    // A beat past the fade, so it ends on its own rather than cut short.
    const timer = setTimeout(() => setSpent(key), TURN_FLASH_MS + 250);
    return () => clearTimeout(timer);
  }, [key]);
  return flash !== null && flash.key !== spent ? flash : null;
};
