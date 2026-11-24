import { describe, expect, it } from 'vite-plus/test';
import type { NetworkReading } from './assistantModel.ts';
import type { ParakeetChoice } from './parakeetModel.ts';
import { createParakeetStore, type ParakeetPort } from './parakeetStore.ts';

const WIFI: NetworkReading = { constrained: false, expensive: false, satisfied: true };
const MOBILE: NetworkReading = { constrained: false, expensive: true, satisfied: true };

/** A port whose download finishes or fails when the test says, and whose network moves. */
const fakePort = (
  start: { choice?: ParakeetChoice; here?: boolean; path?: NetworkReading } = {},
) => {
  let here = start.here ?? false;
  let path = start.path ?? WIFI;
  let active = true;
  let choice = start.choice;
  const uses: Array<string> = [];
  const pathListeners = new Set<(path: NetworkReading) => void>();
  let finish: ((ok: boolean) => void) | undefined;
  let progress: ((fraction: number) => void) | undefined;
  let downloads = 0;
  let prepared = 0;
  const port: ParakeetPort = {
    active: () => active,
    cancel: () => finish?.(false),
    download: (onProgress) => {
      downloads += 1;
      progress = onProgress;
      return new Promise((resolve, reject) => {
        finish = (ok) => {
          finish = undefined;
          if (ok) {
            here = true;
            resolve();
          } else {
            reject(new Error('The network connection was lost.'));
          }
        };
      });
    },
    files: async () => ({ bytes: here ? 712_000_000 : 0, here }),
    network: {
      path: () => path,
      subscribe: (listener) => {
        pathListeners.add(listener);
        return () => pathListeners.delete(listener);
      },
    },
    prepare: async () => {
      prepared += 1;
    },
    readChoice: async () => choice,
    remove: async () => {
      here = false;
    },
    use: async (on, vocabulary) => {
      uses.push(`${String(on)} [${vocabulary.join(', ')}]`);
    },
    writeChoice: async (next) => {
      choice = next;
    },
  };
  return {
    background: () => {
      active = false;
    },
    cancelLate: () => {
      const cancelled = finish;
      finish = undefined;
      setTimeout(() => cancelled?.(false), 5);
    },
    choice: () => choice,
    downloads: () => downloads,
    finish: async (ok: boolean) => {
      finish?.(ok);
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
    foreground: () => {
      active = true;
    },
    moveTo: (next: NetworkReading) => {
      path = next;
      for (const listener of pathListeners) {
        listener(next);
      }
    },
    port,
    prepared: () => prepared,
    progress: (fraction: number) => progress?.(fraction),
    uses,
  };
};

/** Lets the store's awaits run: a choice written, a download begun. */
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('createParakeetStore', () => {
  it('starts on with nothing asked for, and reads with Parakeet once it is here', async () => {
    const fake = fakePort();
    const store = createParakeetStore({ port: fake.port, supported: true });
    await store.boot();
    expect(store.getState()).toEqual({ files: { kind: 'absent' }, on: true });
    expect(fake.downloads()).toBe(0);
    await store.vocabulary(['Thomas Karpfeneder']);
    expect(fake.uses.at(-1)).toBe('false []');

    const asked = store.download('wifi');
    await tick();
    fake.progress(0.5);
    expect(store.getState().files).toEqual({ kind: 'downloading', progress: 0.5 });
    await fake.finish(true);
    await asked;
    expect(store.getState().files).toEqual({ bytes: 712_000_000, kind: 'ready' });
    expect(fake.uses.at(-1)).toBe('true [Thomas Karpfeneder]');
  });

  it('waits for Wi-Fi on mobile data, and goes on there or once mobile data is allowed', async () => {
    const fake = fakePort({ path: MOBILE });
    const store = createParakeetStore({ port: fake.port, supported: true });
    await store.boot();
    await store.download('wifi');
    expect(store.getState().files).toEqual({ for: 'wifi', kind: 'waiting', progress: 0 });
    expect(fake.downloads()).toBe(0);
    fake.moveTo(WIFI);
    expect(store.getState().files.kind).toBe('downloading');
    // Back on mobile data mid-download: it stops and waits again, a wait, not a failure.
    fake.progress(0.3);
    fake.moveTo(MOBILE);
    await fake.finish(false);
    expect(store.getState().files).toEqual({ for: 'wifi', kind: 'waiting', progress: 0.3 });
    void store.allowMobileData();
    await tick();
    expect(fake.choice()).toEqual({ download: 'any', on: true });
    expect(store.getState().files.kind).toBe('downloading');
  });

  it('picks up a download asked for at the last launch, and fetches again what a purge took', async () => {
    const fake = fakePort({ choice: { download: 'any', on: true } });
    const store = createParakeetStore({ port: fake.port, supported: true });
    await store.boot();
    expect(store.getState().files.kind).toBe('downloading');
    // Switched off before: nothing is fetched, though it was asked for.
    const off = fakePort({ choice: { download: 'any', on: false } });
    const quiet = createParakeetStore({ port: off.port, supported: true });
    await quiet.boot();
    expect(quiet.getState()).toEqual({ files: { kind: 'absent' }, on: false });
    expect(off.downloads()).toBe(0);
  });

  it('says a download failed, and goes on after one the background cut', async () => {
    const fake = fakePort();
    const store = createParakeetStore({ port: fake.port, supported: true });
    await store.boot();
    void store.download('any');
    await tick();
    await fake.finish(false);
    expect(store.getState().files).toEqual({
      kind: 'failed',
      message: 'The network connection was lost.',
    });
    void store.retry();
    await tick();
    fake.background();
    await fake.finish(false);
    expect(store.getState().files.kind).toBe('downloading');
    fake.foreground();
    store.resume();
    await tick();
    expect(fake.downloads()).toBe(3);
  });

  it('switched off, reads without Parakeet and stops a download; deleting keeps the switch', async () => {
    const fake = fakePort({ here: true });
    const store = createParakeetStore({ port: fake.port, supported: true });
    await store.boot();
    await store.vocabulary(['Kaffemik']);
    expect(fake.uses.at(-1)).toBe('true [Kaffemik]');
    await store.setOn(false);
    expect(fake.uses.at(-1)).toBe('false []');
    expect(fake.choice()).toEqual({ on: false });
    await store.setOn(true);
    expect(fake.uses.at(-1)).toBe('true [Kaffemik]');
    await store.remove();
    expect(store.getState()).toEqual({ files: { kind: 'absent' }, on: true });
    expect(fake.uses.at(-1)).toBe('false []');
    // Off, deleting leaves it off: the switch is not the default again.
    const off = fakePort({ choice: { on: false }, here: true });
    const quiet = createParakeetStore({ port: off.port, supported: true });
    await quiet.boot();
    await quiet.remove();
    expect(quiet.getState()).toEqual({ files: { kind: 'absent' }, on: false });
    expect(off.choice()).toEqual({ on: false });

    const asked = fakePort();
    const running = createParakeetStore({ port: asked.port, supported: true });
    await running.boot();
    void running.download('any');
    await tick();
    await running.setOn(false);
    await asked.finish(false);
    expect(running.getState()).toEqual({ files: { kind: 'absent' }, on: false });
  });

  it('waits for Wi-Fi, with mobile data on offer, once a phone without a connection gets one', async () => {
    const fake = fakePort({ path: { constrained: false, expensive: false, satisfied: false } });
    const store = createParakeetStore({ port: fake.port, supported: true });
    await store.boot();
    await store.download('wifi');
    expect(store.getState().files).toEqual({ for: 'network', kind: 'waiting', progress: 0 });
    fake.moveTo(MOBILE);
    expect(store.getState().files).toEqual({ for: 'wifi', kind: 'waiting', progress: 0 });
    expect(fake.downloads()).toBe(0);
  });

  it('prepares the models right after a download, so the first phrase finds them', async () => {
    const fake = fakePort();
    const store = createParakeetStore({ port: fake.port, supported: true });
    await store.boot();
    const asked = store.download('any');
    await tick();
    await fake.finish(true);
    await asked;
    expect(fake.prepared()).toBe(1);
  });

  it('loads the models as a phrase starts, never at launch, and only while it reads with them', async () => {
    const fake = fakePort({ here: true });
    const store = createParakeetStore({ port: fake.port, supported: true });
    await store.boot();
    expect(fake.prepared()).toBe(0);
    await store.vocabulary(['Kaffemik']);
    expect(fake.prepared()).toBe(1);
    await store.setOn(false);
    await store.vocabulary(['Kaffemik']);
    expect(fake.prepared()).toBe(1);
  });

  it('starts again at once when the network comes back before the cancel lands', async () => {
    const fake = fakePort({ path: WIFI });
    // The cancel takes the download under way at once; its rejection lands later.
    const slowCancel = { ...fake.port, cancel: fake.cancelLate };
    const store = createParakeetStore({ port: slowCancel, supported: true });
    await store.boot();
    void store.download('wifi');
    await tick();
    fake.moveTo(MOBILE);
    expect(store.getState().files.kind).toBe('waiting');
    fake.moveTo(WIFI);
    expect(store.getState().files.kind).toBe('downloading');
    await new Promise((resolve) => setTimeout(resolve, 10));
    // The first download's late end is neither the answer nor a failure: the second runs on.
    expect(store.getState().files.kind).toBe('downloading');
    expect(fake.downloads()).toBe(2);
  });

  it('does nothing where the build has no Parakeet', async () => {
    const store = createParakeetStore({ reason: 'off', supported: false });
    await store.download('any');
    expect(store.getState()).toEqual({ files: { kind: 'unsupported', reason: 'off' }, on: false });
  });
});
