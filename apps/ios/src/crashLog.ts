import { File, Paths } from 'expo-file-system';

/**
 * The last uncaught render error, kept in the app's documents directory.
 * Desktop writes its ErrorBoundary catches to the log file; a TestFlight
 * build has no Metro console, so without this a render crash on a tester's
 * phone left nothing to read. Settings › Diagnostics shows it.
 */
const FILE_NAME = 'last-render-error.txt';

const file = () => new File(Paths.document, FILE_NAME);

export interface RecordedError {
  /** ISO timestamp of the catch. */
  readonly at: string;
  readonly detail: string;
}

export const recordRenderError = (error: unknown): void => {
  const stack =
    typeof error === 'object' && error !== null && 'stack' in error ? String(error.stack) : '';
  try {
    file().write(`${new Date().toISOString()}\n${String(error)}\n${stack}`);
  } catch {
    // Logging must never throw inside componentDidCatch.
  }
};

export const readLastRenderError = (): RecordedError | null => {
  try {
    const target = file();
    if (!target.exists) {
      return null;
    }
    const [at = '', ...rest] = target.textSync().split('\n');
    return { at, detail: rest.join('\n').trim() };
  } catch {
    return null;
  }
};

export const clearLastRenderError = (): void => {
  try {
    const target = file();
    if (target.exists) {
      target.delete();
    }
  } catch {
    // Nothing to clear, or the file is unreadable — either way it is gone from the UI.
  }
};
