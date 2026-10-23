/**
 * A request to show the setup dialog from somewhere it is not mounted —
 * the sidebar card's "Add your accounts" row lives in the calendar, the
 * dialog in the window's root. One listener (the dialog), many askers.
 */
const listeners = new Set<() => void>();

/** Opens the setup dialog on "What do you use?". */
export const requestSetup = (): void => {
  for (const listener of listeners) {
    listener();
  }
};

export const onSetupRequested = (listener: () => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
