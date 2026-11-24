import { File, Paths } from 'expo-file-system';

/**
 * The last error of a kind, kept in the app's documents directory: a
 * TestFlight build has no Metro console, so without it a failure on a
 * tester's phone left nothing to read. Settings › Advanced › Diagnostics
 * shows it.
 */
export interface RecordedError {
  /** ISO timestamp of the catch. */
  readonly at: string;
  readonly detail: string;
}

const lastError = (fileName: string) => {
  const file = () => new File(Paths.document, fileName);
  return {
    clear: (): void => {
      try {
        const target = file();
        if (target.exists) {
          target.delete();
        }
      } catch {
        // Nothing to clear, or the file is unreadable — either way it is gone from the UI.
      }
    },
    read: (): RecordedError | null => {
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
    },
    record: (detail: string): void => {
      try {
        // Synchronous: the write must land inside this try, before a crash.
        file().writeSync(`${new Date().toISOString()}\n${detail}`);
      } catch {
        // Logging must never throw where it is called (componentDidCatch, a catch).
      }
    },
  };
};

const renderError = lastError('last-render-error.txt');

/** The last uncaught render error. Desktop writes its ErrorBoundary catches to the log file. */
export const recordRenderError = (error: unknown): void => {
  const stack =
    typeof error === 'object' && error !== null && 'stack' in error ? String(error.stack) : '';
  renderError.record(`${String(error)}\n${stack}`);
};

export const readLastRenderError = renderError.read;
export const clearLastRenderError = renderError.clear;

const dictationError = lastError('last-dictation-error.txt');

/**
 * The last error the speech module answered, with the step that failed
 * ("read", "finish", "start"): the editor itself only says "Could not
 * transcribe that.", and a failure only a real iPhone shows (the simulator
 * has no speech assets) needs its words.
 */
export const recordDictationError = (step: string, error: unknown): void => {
  dictationError.record(`${step}: ${String(error)}`);
};

export const readLastDictationError = dictationError.read;
export const clearLastDictationError = dictationError.clear;
