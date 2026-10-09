import { describe, expect, it } from 'vite-plus/test';
import { runOneWrite, type WriteSlot } from './oneWrite.ts';

const deferred = () => {
  let settle: { reject: (error: unknown) => void; resolve: () => void } | undefined;
  const promise = new Promise<void>((resolve, reject) => {
    settle = { reject, resolve };
  });
  return { promise, settle: settle! };
};

describe('runOneWrite', () => {
  it('a second save while the first is in flight starts nothing', async () => {
    const slot: WriteSlot = { current: null };
    const pending = deferred();
    let writes = 0;
    const save = () => {
      writes += 1;
      return pending.promise;
    };

    const first = runOneWrite(slot, save);
    const second = runOneWrite(slot, save);
    expect(writes).toBe(1);
    expect(second).toBe(first);

    pending.settle.resolve();
    await first;
    // Free again once it ends.
    await runOneWrite(slot, async () => {
      writes += 1;
    });
    expect(writes).toBe(2);
  });

  it('frees the slot when the write fails', async () => {
    const slot: WriteSlot = { current: null };
    await expect(runOneWrite(slot, () => Promise.reject(new Error('offline')))).rejects.toThrow(
      'offline',
    );
    expect(slot.current).toBeNull();
  });

  it('reports busy while the write runs', async () => {
    const slot: WriteSlot = { current: null };
    const pending = deferred();
    const busy: Array<boolean> = [];
    const running = runOneWrite(
      slot,
      () => pending.promise,
      (value) => busy.push(value),
    );
    runOneWrite(
      slot,
      () => pending.promise,
      (value) => busy.push(value),
    );
    expect(busy).toEqual([true]);
    pending.settle.resolve();
    await running;
    expect(busy).toEqual([true, false]);
  });
});
