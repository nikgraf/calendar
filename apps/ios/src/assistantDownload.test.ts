import { describe, expect, it } from 'vite-plus/test';
import {
  type AssistantDownloadDeps,
  createAssistantDownload,
  type DownloadAnswer,
  type ModelFiles,
  type NetworkReading,
  statusOf,
  type TransferNetwork,
  type TransferPort,
} from './assistantDownload.ts';
import type { AssistantModelManifest } from './assistantModelManifest.ts';

const MANIFEST: AssistantModelManifest = {
  bytes: 1000,
  file: 'assistant.gguf',
  sha256: 'abc123',
  url: 'https://example.com/assistant.gguf',
  version: 'v1',
};

const WIFI: NetworkReading = { constrained: false, expensive: false, satisfied: true };
const MOBILE: NetworkReading = { constrained: false, expensive: true, satisfied: true };

const fakeFiles = (
  start: {
    answer?: { answer: DownloadAnswer; version: string };
    file?: { sha256: string; size: number };
    verified?: { sha256: string; version: string };
  } = {},
) => {
  let answer = start.answer;
  let file = start.file;
  let verified = start.verified;
  const files: ModelFiles = {
    destination: 'file:///caches/assistant.gguf',
    exists: () => file !== undefined,
    readAnswer: () => answer,
    readVerified: () => verified,
    remove: () => {
      file = undefined;
    },
    sha256: async () => file?.sha256 ?? '',
    size: () => file?.size,
    writeAnswer: (next) => {
      answer = next;
    },
    writeVerified: (next) => {
      verified = next;
    },
  };
  return {
    files,
    land: (sha256 = MANIFEST.sha256, size = MANIFEST.bytes) => {
      file = { sha256, size };
    },
    written: () => ({ answer, verified }),
  };
};

const fakeTransfer = (start: { path?: NetworkReading; running?: TransferNetwork } = {}) => {
  const starts: Array<TransferNetwork> = [];
  const moves: Array<TransferNetwork> = [];
  let handlers: Parameters<TransferPort['subscribe']>[0] | undefined;
  let running = start.running;
  const transfer: TransferPort = {
    cancel: async () => undefined,
    current: async () =>
      running === undefined
        ? { state: 'none' }
        : { expected: 1000, network: running, received: 400, state: 'running' },
    path: () => start.path ?? WIFI,
    start: async (_url, _destination, network) => {
      if (running !== undefined) {
        return { network: running, started: false };
      }
      running = network;
      starts.push(network);
      return { network, started: true };
    },
    subscribe: (next) => {
      handlers = next;
      return () => undefined;
    },
    useNetwork: async (network) => {
      if (running === undefined || running === network) {
        return false;
      }
      running = network;
      moves.push(network);
      return true;
    },
  };
  return { emit: () => handlers!, moves, starts, transfer };
};

const storeOf = (files: ModelFiles, transfer: TransferPort) =>
  createAssistantDownload({
    files,
    manifest: MANIFEST,
    supported: true,
    transfer,
  } satisfies AssistantDownloadDeps);

describe('the Assistant model’s download', () => {
  it('fetches nothing before the person agrees, and asks once a version', async () => {
    const files = fakeFiles();
    const { starts, transfer } = fakeTransfer();
    const store = storeOf(files.files, transfer);
    await store.boot();
    expect(store.getState()).toEqual({ kind: 'unasked' });
    expect(starts).toEqual([]);
    store.decline();
    expect(store.getState()).toEqual({ kind: 'declined' });
    const again = storeOf(files.files, transfer);
    await again.boot();
    expect(again.getState()).toEqual({ kind: 'declined' });
    // A new version asks again.
    const newer = createAssistantDownload({
      files: files.files,
      manifest: { ...MANIFEST, version: 'v2' },
      supported: true,
      transfer,
    });
    await newer.boot();
    expect(newer.getState()).toEqual({ kind: 'unasked' });
  });

  it('goes over Wi-Fi only when agreed so, and waits on mobile data', async () => {
    const { emit, starts, transfer } = fakeTransfer({ path: MOBILE });
    const store = storeOf(fakeFiles().files, transfer);
    await store.boot();
    await store.agree('wifi');
    expect(starts).toEqual(['wifi']);
    expect(store.getState()).toMatchObject({ for: 'wifi', kind: 'waiting' });
    emit().onPath(WIFI);
    emit().onProgress({ expected: 1000, received: 250 });
    expect(store.getState()).toEqual({ kind: 'downloading', received: 250, total: 1000 });
    emit().onPath({ constrained: true, expensive: false, satisfied: true });
    expect(store.getState()).toMatchObject({ for: 'wifi', kind: 'waiting', received: 250 });
    emit().onPath({ constrained: false, expensive: false, satisfied: false });
    expect(store.getState()).toMatchObject({ for: 'network', kind: 'waiting' });
  });

  it('moves a running transfer to mobile data once the person allows it', async () => {
    const files = fakeFiles();
    const { moves, transfer } = fakeTransfer({ path: MOBILE });
    const store = storeOf(files.files, transfer);
    await store.boot();
    await store.agree('wifi');
    await store.allowMobileData();
    expect(moves).toEqual(['any']);
    expect(store.getState()).toMatchObject({ kind: 'downloading' });
    expect(files.written().answer).toEqual({ answer: 'mobile', version: 'v1' });
  });

  it('adopts a transfer the last launch started, on the network the answer allows', async () => {
    const files = fakeFiles({ answer: { answer: 'mobile', version: 'v1' } });
    const { moves, starts, transfer } = fakeTransfer({ running: 'wifi' });
    const store = storeOf(files.files, transfer);
    await store.boot();
    expect(starts).toEqual([]);
    expect(moves).toEqual(['any']);
    expect(store.getState()).toEqual({ kind: 'downloading', received: 400, total: 1000 });
  });

  it('is ready once the file’s size and checksum match, and remembers that', async () => {
    const files = fakeFiles();
    const { emit, transfer } = fakeTransfer();
    const store = storeOf(files.files, transfer);
    await store.boot();
    await store.agree('wifi');
    files.land();
    emit().onFinish({ path: files.files.destination });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState()).toEqual({ kind: 'ready', path: 'file:///caches/assistant.gguf' });
    expect(statusOf(store.getState())).toBe('ready');
    const next = storeOf(files.files, fakeTransfer().transfer);
    await next.boot();
    expect(next.getState().kind).toBe('ready');
  });

  it('checks a file that finished while the app was not running', async () => {
    const files = fakeFiles({ answer: { answer: 'wifi', version: 'v1' } });
    files.land();
    const store = storeOf(files.files, fakeTransfer().transfer);
    await store.boot();
    expect(store.getState().kind).toBe('ready');
  });

  it('throws away a file of the wrong size or checksum, and starts over on Try Again', async () => {
    const files = fakeFiles();
    const { emit, starts, transfer } = fakeTransfer();
    const store = storeOf(files.files, transfer);
    await store.boot();
    await store.agree('wifi');
    files.land('abc123', 999);
    emit().onFinish({ path: files.files.destination });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState()).toEqual({ kind: 'failed', message: 'The download was incomplete.' });
    expect(files.files.exists()).toBe(false);
    await store.retry();
    files.land('other');
    emit().onFinish({ path: files.files.destination });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState()).toEqual({
      kind: 'failed',
      message: 'The downloaded file was not the model.',
    });
    emit().onFail({ message: 'The network connection was lost.', status: 0 });
    expect(store.getState()).toEqual({
      kind: 'failed',
      message: 'The network connection was lost.',
    });
    expect(starts).toEqual(['wifi']);
  });

  it('says unsupported, and does nothing, where the device or build has no Assistant model', async () => {
    const store = createAssistantDownload({ reason: 'fixture', supported: false });
    await store.boot();
    await store.agree('wifi');
    expect(store.getState()).toEqual({ kind: 'unsupported', reason: 'fixture' });
    expect(statusOf(store.getState())).toBe('unsupported');
  });

  it('does not fetch a wrong file again by itself at the next launch', async () => {
    const files = fakeFiles();
    const { emit, starts, transfer } = fakeTransfer();
    const store = storeOf(files.files, transfer);
    await store.boot();
    await store.agree('wifi');
    files.land('other');
    emit().onFinish({ path: files.files.destination });
    await new Promise((resolve) => setTimeout(resolve, 0));
    const next = fakeTransfer();
    const relaunched = storeOf(files.files, next.transfer);
    await relaunched.boot();
    expect(relaunched.getState()).toEqual({
      kind: 'failed',
      message: 'The downloaded file was not the model.',
    });
    expect(next.starts).toEqual([]);
    await relaunched.retry();
    expect(next.starts).toEqual(['wifi']);
    expect(starts).toEqual(['wifi']);
  });

  it('ignores another file’s finish, and cancels a transfer when the person declines', async () => {
    const files = fakeFiles();
    const cancelled: Array<string> = [];
    const { emit, transfer } = fakeTransfer();
    const store = storeOf(files.files, {
      ...transfer,
      cancel: async (destination) => {
        cancelled.push(destination);
      },
    });
    await store.boot();
    await store.agree('wifi');
    files.land();
    emit().onFinish({ path: 'file:///caches/older.gguf' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.getState().kind).toBe('downloading');
    store.decline();
    expect(store.getState()).toEqual({ kind: 'declined' });
    expect(cancelled.at(-1)).toBe('file:///caches/assistant.gguf');
  });
});
