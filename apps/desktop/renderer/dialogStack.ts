/** Where a window's dialogs listen for keys (the window itself, in the app). */
type KeyTarget = Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;

/**
 * The open dialogs of a window, in mount order. Each listens for Escape on
 * the window, in the capture phase; only the topmost — highest zIndex,
 * then the last opened — answers it. One Escape used to close them all,
 * so dismissing an agent request also threw away a half-edited event.
 * (Tab is kept inside each dialog by its own `FocusTrap`.)
 *
 * Escape stops with stopImmediatePropagation, not stopPropagation: the
 * other dialogs listen on the same target, which stopPropagation does not
 * stop. For a native key the browser runs microtasks between listeners,
 * so React commits the closed dialog's unmount before the next listener
 * runs — that one would find itself on top and close too (an approval
 * opened before the editor under it).
 */
export const makeDialogStack = (target: KeyTarget) => {
  const open: Array<{ readonly zIndex: number }> = [];
  const topmost = () =>
    open.reduce<{ readonly zIndex: number } | undefined>(
      (top, entry) => (top === undefined || entry.zIndex >= top.zIndex ? entry : top),
      undefined,
    );
  return {
    /** Whether any dialog is open: the calendar's own keys stand back. */
    isOpen: (): boolean => open.length > 0,
    /** Registers an open dialog; returns what closes it. */
    open: (zIndex: number, onEscape: () => void): (() => void) => {
      const entry = { zIndex };
      open.push(entry);
      const onKeyDown = (event: Event) => {
        if (topmost() !== entry) {
          return;
        }
        if ((event as KeyboardEvent).key === 'Escape') {
          event.stopImmediatePropagation();
          onEscape();
        }
      };
      target.addEventListener('keydown', onKeyDown, true);
      return () => {
        open.splice(open.indexOf(entry), 1);
        target.removeEventListener('keydown', onKeyDown, true);
      };
    },
  };
};
