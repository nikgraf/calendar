import { useRef, useState } from 'react';

/** The write in flight, if any: an editor's, or an action's (`action.ts`). */
export interface WriteSlot {
  current: Promise<void> | null;
}

/**
 * Runs `write` unless one is already in flight in `slot`; a call meanwhile
 * gets the running write's promise and starts nothing. The slot is taken
 * before `write` starts, so a call from the write's own first,
 * synchronous part is turned away like any other, and frees however the
 * write ends — a throw before its first await included. `useOneWrite` is
 * the editors' hook over it, `runAction` (`action.ts`) the actions'.
 */
export const runOneWrite = (
  slot: WriteSlot,
  write: () => Promise<void>,
  onBusy?: (busy: boolean) => void,
): Promise<void> => {
  if (slot.current) {
    return slot.current;
  }
  // The promise exists, and holds the slot, before the write is started.
  let begin: (() => void) | undefined;
  const running = new Promise<void>((resolve, reject) => {
    begin = () => {
      try {
        resolve(write());
      } catch (error) {
        reject(error);
      }
    };
  }).finally(() => {
    slot.current = null;
    onBusy?.(false);
  });
  slot.current = running;
  onBusy?.(true);
  begin?.();
  return running;
};

/**
 * One write at a time from an editor. A second tap on Save used to create
 * a second event or task: nothing stopped it while the first was still
 * waiting (behind a history import, or on a move/convert confirmation).
 * The slot, set synchronously, turns a second press away even before a
 * render; `busy` only dims Save and Delete. Disabling them was worse: the
 * button came back only on the next render, so a press right after a
 * declined move or convert confirmation landed on it and did nothing.
 * Save and Delete share one slot.
 */
export const useOneWrite = () => {
  const slot = useRef<WriteSlot>({ current: null });
  const [busy, setBusy] = useState(false);
  const run = (write: () => Promise<void>): Promise<void> =>
    runOneWrite(slot.current, write, setBusy);
  return { busy, run };
};
