import type { AssistantModelManifest, AssistantModelState } from '@calendar/ai';

/**
 * The Assistant's model on this Mac, one state at a time (the shape the
 * iPhone uses, `@calendar/ai`'s `AssistantModelState`, without its network
 * waits). Nothing is fetched before the person agrees: the question at
 * launch or the Assistant's Download button. Once agreed, every launch
 * goes on where the last one stopped. A file is used once its size and
 * SHA-256 match the manifest. A new version asks again.
 */

/** The person's answer, kept per model version. */
export type MacAnswer = 'agreed' | 'declined';

/** The files the store keeps under the profile's `assistant-model/` folder. */
export interface ModelFiles {
  /** The model's path once it is in place. */
  readonly destination: string;
  readonly exists: () => boolean;
  /** Moves the finished download into place. */
  readonly finish: () => Promise<void>;
  /** Bytes already fetched into the partial file, 0 without one. */
  readonly partSize: () => number;
  readonly readAnswer: () => { readonly answer: MacAnswer; readonly version: string } | undefined;
  readonly readVerified: () => { readonly sha256: string; readonly version: string } | undefined;
  /** The model and its partial file go (a wrong file, or another version's). */
  readonly remove: () => Promise<void>;
  /** Files of another model version go, so an old release takes no room. */
  readonly removeOthers: () => Promise<void>;
  readonly sha256: () => Promise<string>;
  readonly size: () => number | undefined;
  readonly writeAnswer: (answer: { readonly answer: MacAnswer; readonly version: string }) => void;
  readonly writeVerified: (verified: { readonly sha256: string; readonly version: string }) => void;
}

/** Fetches `url` into the partial file from byte `from` on, reporting what has arrived. */
export type Fetch = (request: {
  readonly from: number;
  readonly onProgress: (received: number, total: number) => void;
  readonly signal: AbortSignal;
  readonly url: string;
}) => Promise<void>;

export interface AssistantStore {
  /** The person said yes: the question at launch, or the Assistant's Download button. */
  readonly agree: () => Promise<void>;
  /** At launch: picks up where the last launch left off. */
  readonly boot: () => Promise<void>;
  readonly decline: () => void;
  readonly getState: () => AssistantModelState;
  readonly retry: () => Promise<void>;
  /** Stops a transfer (the app quits): the partial file stays for the next launch. */
  readonly stop: () => void;
  readonly subscribe: (listener: (state: AssistantModelState) => void) => () => void;
}

const MISMATCH = 'The downloaded file was not the model.';

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const createAssistantStore = ({
  fetch,
  files,
  manifest,
}: {
  readonly fetch: Fetch;
  readonly files: ModelFiles;
  readonly manifest: AssistantModelManifest;
}): AssistantStore => {
  const listeners = new Set<(state: AssistantModelState) => void>();
  let state: AssistantModelState = { kind: 'unasked' };
  let transfer: AbortController | undefined;
  const set = (next: AssistantModelState) => {
    state = next;
    for (const listener of listeners) {
      listener(state);
    }
  };

  const answer = (): MacAnswer | undefined => {
    const said = files.readAnswer();
    return said?.version === manifest.version ? said.answer : undefined;
  };

  const verified = (): boolean => {
    const note = files.readVerified();
    return (
      note?.version === manifest.version &&
      note.sha256 === manifest.sha256 &&
      files.exists() &&
      files.size() === manifest.bytes
    );
  };

  const verify = async () => {
    set({ kind: 'verifying' });
    if (files.size() !== manifest.bytes) {
      await files.remove();
      set({ kind: 'failed', message: 'The download was incomplete.' });
      return;
    }
    let sha256: string;
    try {
      sha256 = await files.sha256();
    } catch {
      set({ kind: 'failed', message: 'The downloaded file could not be read.' });
      return;
    }
    if (sha256.toLowerCase() !== manifest.sha256.toLowerCase()) {
      await files.remove();
      // Kept, so the next launch does not fetch the same wrong file by itself.
      files.writeVerified({ sha256, version: manifest.version });
      set({ kind: 'failed', message: MISMATCH });
      return;
    }
    files.writeVerified({ sha256: manifest.sha256, version: manifest.version });
    set({ kind: 'ready', path: files.destination });
  };

  const download = async () => {
    if (transfer) {
      return;
    }
    const controller = new AbortController();
    transfer = controller;
    const from = files.partSize();
    set({ kind: 'downloading', received: from, total: manifest.bytes });
    try {
      await fetch({
        from,
        onProgress: (received, total) => {
          if (transfer === controller) {
            set({ kind: 'downloading', received, total: total > 0 ? total : manifest.bytes });
          }
        },
        signal: controller.signal,
        url: manifest.url,
      });
      await files.finish();
    } catch (error) {
      if (transfer === controller) {
        transfer = undefined;
        if (!controller.signal.aborted) {
          set({ kind: 'failed', message: messageOf(error) });
        }
      }
      return;
    }
    transfer = undefined;
    await verify();
  };

  return {
    agree: async () => {
      files.writeAnswer({ answer: 'agreed', version: manifest.version });
      await download();
    },
    boot: async () => {
      await files.removeOthers().catch(() => undefined);
      if (verified()) {
        set({ kind: 'ready', path: files.destination });
        return;
      }
      const said = answer();
      if (said !== 'agreed') {
        set({ kind: said === 'declined' ? 'declined' : 'unasked' });
        return;
      }
      // Fetched before the app quit, not yet checked: the check runs now.
      if (files.exists()) {
        await verify();
        return;
      }
      // The last file was the wrong one: Try Again fetches it once more, not every launch.
      const note = files.readVerified();
      if (note?.version === manifest.version && note.sha256 !== manifest.sha256) {
        set({ kind: 'failed', message: MISMATCH });
        return;
      }
      await download();
    },
    decline: () => {
      files.writeAnswer({ answer: 'declined', version: manifest.version });
      transfer?.abort();
      transfer = undefined;
      set({ kind: 'declined' });
    },
    getState: () => state,
    retry: async () => {
      files.writeAnswer({ answer: 'agreed', version: manifest.version });
      await download();
    },
    stop: () => {
      transfer?.abort();
      transfer = undefined;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
