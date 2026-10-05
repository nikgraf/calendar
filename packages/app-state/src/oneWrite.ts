import { useRef, useState } from 'react';

/** The write an editor has in flight, if any. */
export interface WriteSlot {
  current: Promise<void> | null;
}

/**
 * Runs `write` unless one is already in flight in `slot`; a call meanwhile
 * gets the running write's promise and starts nothing. The slot frees
 * however the write ends. Exported for tests: `useOneWrite` is the hook.
 */
export const runOneWrite = (
  slot: WriteSlot,
  write: () => Promise<void>,
  onBusy?: (busy: boolean) => void,
): Promise<void> => {
  if (slot.current) {
    return slot.current;
  }
  onBusy?.(true);
  const running = write().finally(() => {
    slot.current = null;
    onBusy?.(false);
  });
  slot.current = running;
  return running;
};

/**
 * One write at a time from an editor. A second tap on Save used to create
 * a second event or task: nothing stopped it while the first was still
 * waiting (behind a history import, or on a move/convert confirmation).
 * `busy` disables the buttons; the slot, set synchronously, also covers a
 * tap that lands before that render. Save and Delete share one slot.
 */
export const useOneWrite = () => {
  const slot = useRef<WriteSlot>({ current: null });
  const [busy, setBusy] = useState(false);
  const run = (write: () => Promise<void>): Promise<void> =>
    runOneWrite(slot.current, write, setBusy);
  return { busy, run };
};
