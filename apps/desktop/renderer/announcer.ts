/**
 * Holds what a live region should say until the region has had a moment to
 * register, then hands over everything that waited, together. A text that
 * arrives while others wait joins them: it never replaces one — the
 * announce-once rule has already marked that one told — and it never
 * restarts the delay, so a steady stream cannot hold the first back.
 */
export const makeAnnouncer = (delayMs: number, deliver: (texts: ReadonlyArray<string>) => void) => {
  let waiting: Array<string> = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  return {
    say: (text: string): void => {
      waiting.push(text);
      timer ??= setTimeout(() => {
        timer = undefined;
        const texts = waiting;
        waiting = [];
        deliver(texts);
      }, delayMs);
    },
    /** Drops what waits (the region is going away). */
    stop: (): void => {
      clearTimeout(timer);
      timer = undefined;
      waiting = [];
    },
  };
};
