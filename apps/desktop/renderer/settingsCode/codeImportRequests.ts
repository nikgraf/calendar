/**
 * A settings code to import, from somewhere the import dialog is not
 * mounted: the calendar's ⌘V and the ⌘K field hand a pasted code here
 * instead of to the AI capture; the dialog lives in the window's root.
 * One listener (the dialog host), many askers.
 */
const listeners = new Set<(code: string) => void>();

export const requestCodeImport = (code: string): void => {
  for (const listener of listeners) {
    listener(code);
  }
};

export const onCodeImportRequested = (listener: (code: string) => void): (() => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
