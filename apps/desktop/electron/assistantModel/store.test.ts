import type { AssistantModelManifest, AssistantModelState } from '@calendar/ai';
import { describe, expect, it } from 'vite-plus/test';
import { createAssistantStore, type Fetch, type MacAnswer, type ModelFiles } from './store.ts';

const MANIFEST: AssistantModelManifest = {
  bytes: 1000,
  file: 'assistant.gguf',
  sha256: 'abc123',
  url: 'https://example.com/assistant.gguf',
  version: 'v1',
};

/** The store's files in memory: the model, a partial file, the two notes. */
const memoryFiles = (start: {
  answer?: { answer: MacAnswer; version: string };
  model?: number | undefined;
  part?: number | undefined;
  sha256?: string | undefined;
  verified?: { sha256: string; version: string };
}) => {
  const disk = { ...start, removedOthers: 0 };
  const files: ModelFiles = {
    destination: '/profile/assistant-model/assistant.gguf',
    exists: () => disk.model !== undefined,
    finish: async () => {
      disk.model = disk.part;
      disk.part = undefined;
    },
    partSize: () => disk.part ?? 0,
    readAnswer: () => disk.answer,
    readVerified: () => disk.verified,
    remove: async () => {
      disk.model = undefined;
      disk.part = undefined;
    },
    removeOthers: async () => {
      disk.removedOthers += 1;
    },
    sha256: async () => disk.sha256 ?? MANIFEST.sha256,
    size: () => disk.model,
    writeAnswer: (answer) => {
      disk.answer = answer;
    },
    writeVerified: (verified) => {
      disk.verified = verified;
    },
  };
  return { disk, files };
};

/** A fetch that writes `bytes` into the partial file and records where each started. */
const fakeFetch = (disk: { part?: number | undefined }, bytes = MANIFEST.bytes) => {
  const starts: Array<number> = [];
  const fetch: Fetch = async ({ from, onProgress }) => {
    starts.push(from);
    onProgress(Math.floor(bytes / 2), bytes);
    disk.part = bytes;
    onProgress(bytes, bytes);
  };
  return { fetch, starts };
};

const record = (store: ReturnType<typeof createAssistantStore>) => {
  const seen: Array<AssistantModelState['kind']> = [];
  store.subscribe((state) => seen.push(state.kind));
  return seen;
};

describe('createAssistantStore', () => {
  it('fetches nothing before the person agrees, then downloads, checks and is ready', async () => {
    const { disk, files } = memoryFiles({});
    const { fetch, starts } = fakeFetch(disk);
    const store = createAssistantStore({ fetch, files, manifest: MANIFEST });
    await store.boot();
    expect(store.getState()).toEqual({ kind: 'unasked' });
    expect(starts).toEqual([]);
    const seen = record(store);
    await store.agree();
    expect(seen).toEqual(['downloading', 'downloading', 'downloading', 'verifying', 'ready']);
    expect(store.getState()).toEqual({ kind: 'ready', path: files.destination });
    expect(disk.answer).toEqual({ answer: 'agreed', version: 'v1' });
    expect(disk.verified).toEqual({ sha256: 'abc123', version: 'v1' });
    expect(disk.removedOthers).toBe(1);
  });

  it('is ready at launch with a checked file, and fetches nothing', async () => {
    const { disk, files } = memoryFiles({
      answer: { answer: 'agreed', version: 'v1' },
      model: 1000,
      verified: { sha256: 'abc123', version: 'v1' },
    });
    const { fetch, starts } = fakeFetch(disk);
    const store = createAssistantStore({ fetch, files, manifest: MANIFEST });
    await store.boot();
    expect(store.getState().kind).toBe('ready');
    expect(starts).toEqual([]);
  });

  it('goes on at launch from the bytes the last launch fetched', async () => {
    const { disk, files } = memoryFiles({ answer: { answer: 'agreed', version: 'v1' }, part: 400 });
    const { fetch, starts } = fakeFetch(disk);
    const store = createAssistantStore({ fetch, files, manifest: MANIFEST });
    await store.boot();
    expect(starts).toEqual([400]);
    expect(store.getState().kind).toBe('ready');
  });

  it('checks a file that finished before the app quit, without fetching it again', async () => {
    const { disk, files } = memoryFiles({
      answer: { answer: 'agreed', version: 'v1' },
      model: 1000,
    });
    const { fetch, starts } = fakeFetch(disk);
    const store = createAssistantStore({ fetch, files, manifest: MANIFEST });
    await store.boot();
    expect(starts).toEqual([]);
    expect(store.getState().kind).toBe('ready');
  });

  it('keeps "Not Now", and asks again for a new version', async () => {
    const { disk, files } = memoryFiles({ answer: { answer: 'declined', version: 'v1' } });
    const { fetch, starts } = fakeFetch(disk);
    const declined = createAssistantStore({ fetch, files, manifest: MANIFEST });
    await declined.boot();
    expect(declined.getState()).toEqual({ kind: 'declined' });
    const next = createAssistantStore({ fetch, files, manifest: { ...MANIFEST, version: 'v2' } });
    await next.boot();
    expect(next.getState()).toEqual({ kind: 'unasked' });
    expect(starts).toEqual([]);
  });

  it('asks a new version as an update where an earlier one was downloaded', async () => {
    const { disk, files } = memoryFiles({ answer: { answer: 'agreed', version: 'v1' } });
    const { fetch, starts } = fakeFetch(disk);
    const next = createAssistantStore({ fetch, files, manifest: { ...MANIFEST, version: 'v2' } });
    await next.boot();
    expect(next.getState()).toEqual({ kind: 'unasked', update: true });
    expect(starts).toEqual([]);
    next.decline();
    expect(next.getState()).toEqual({ kind: 'declined' });
  });

  it('throws a wrong file away, and does not fetch it again by itself at the next launch', async () => {
    const { disk, files } = memoryFiles({ sha256: 'evil' });
    const { fetch, starts } = fakeFetch(disk);
    const store = createAssistantStore({ fetch, files, manifest: MANIFEST });
    await store.boot();
    await store.agree();
    expect(store.getState()).toEqual({
      kind: 'failed',
      message: 'The downloaded file was not the model.',
    });
    expect(disk.model).toBeUndefined();
    const relaunched = createAssistantStore({ fetch, files, manifest: MANIFEST });
    await relaunched.boot();
    expect(relaunched.getState().kind).toBe('failed');
    expect(starts).toEqual([0]);
    // Try Again fetches it once more.
    disk.sha256 = undefined;
    await relaunched.retry();
    expect(starts).toEqual([0, 0]);
    expect(relaunched.getState().kind).toBe('ready');
  });

  it('fails on an incomplete file and on a broken transfer, and tries again on request', async () => {
    const { disk, files } = memoryFiles({});
    const short = createAssistantStore({
      fetch: fakeFetch(disk, 600).fetch,
      files,
      manifest: MANIFEST,
    });
    await short.agree();
    expect(short.getState()).toEqual({ kind: 'failed', message: 'The download was incomplete.' });
    let calls = 0;
    const broken = createAssistantStore({
      fetch: async () => {
        calls += 1;
        throw new Error('The server answered 503.');
      },
      files,
      manifest: MANIFEST,
    });
    await broken.agree();
    expect(broken.getState()).toEqual({ kind: 'failed', message: 'The server answered 503.' });
    await broken.retry();
    expect(calls).toBe(2);
  });

  it('stops a transfer without calling it a failure, and declining stops one too', async () => {
    const { files } = memoryFiles({});
    let release: (() => void) | undefined;
    const fetch: Fetch = ({ signal }) =>
      new Promise((resolve, reject) => {
        release = resolve;
        signal.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const store = createAssistantStore({ fetch, files, manifest: MANIFEST });
    const agreed = store.agree();
    expect(store.getState().kind).toBe('downloading');
    store.stop();
    await agreed;
    expect(store.getState().kind).toBe('downloading');
    const again = store.agree();
    store.decline();
    await again;
    expect(store.getState()).toEqual({ kind: 'declined' });
    release?.();
  });

  it('takes a part that is already whole without asking for more (a server answers 416 past the end)', async () => {
    const { disk, files } = memoryFiles({
      answer: { answer: 'agreed', version: 'v1' },
      part: 1000,
    });
    const starts: Array<number> = [];
    const store = createAssistantStore({
      fetch: async ({ from }) => {
        starts.push(from);
        throw new Error('The server answered 416.');
      },
      files,
      manifest: MANIFEST,
    });
    await store.boot();
    expect(starts).toEqual([]);
    expect(store.getState().kind).toBe('ready');
    expect(disk.model).toBe(1000);
  });

  it('throws away a part longer than the file, so Try Again fetches it from the start', async () => {
    const { disk, files } = memoryFiles({
      answer: { answer: 'agreed', version: 'v1' },
      part: 1200,
    });
    const { fetch, starts } = fakeFetch(disk);
    const store = createAssistantStore({ fetch, files, manifest: MANIFEST });
    await store.boot();
    expect(store.getState()).toEqual({ kind: 'failed', message: 'The download was incomplete.' });
    await store.retry();
    expect(starts).toEqual([0]);
    expect(store.getState().kind).toBe('ready');
  });
});
