import { describe, expect, it } from 'vitest';
import { guardMutation, type MutationNotice, subscribeMutationNotices } from './mutationGuard.ts';

describe('guardMutation', () => {
  it('passes arguments through and resolves silently on success', async () => {
    const seen: Array<MutationNotice> = [];
    const unsubscribe = subscribeMutationNotices((notice) => seen.push(notice));
    const calls: Array<unknown> = [];
    const guarded = guardMutation('save', (arg: number) => {
      calls.push(arg);
      return Promise.resolve('ok');
    });
    await guarded(7);
    unsubscribe();
    expect(calls).toEqual([7]);
    expect(seen).toEqual([]);
  });

  it('publishes a notice instead of rejecting', async () => {
    const seen: Array<MutationNotice> = [];
    const unsubscribe = subscribeMutationNotices((notice) => seen.push(notice));
    const guarded = guardMutation('reschedule the event', () =>
      Promise.reject(new Error('SqlError: database is locked')),
    );
    // Must not throw — the whole point.
    await guarded();
    unsubscribe();
    expect(seen).toEqual([
      { action: 'reschedule the event', detail: 'SqlError: database is locked' },
    ]);
  });

  it('truncates long failure details and stringifies non-Error rejections', async () => {
    const seen: Array<MutationNotice> = [];
    const unsubscribe = subscribeMutationNotices((notice) => seen.push(notice));
    await guardMutation('save', () => Promise.reject('x'.repeat(500)))();
    unsubscribe();
    expect(seen[0]?.detail.length).toBe(141);
    expect(seen[0]?.detail.endsWith('…')).toBe(true);
  });

  it('unsubscribed listeners stop receiving notices', async () => {
    const seen: Array<MutationNotice> = [];
    const unsubscribe = subscribeMutationNotices((notice) => seen.push(notice));
    unsubscribe();
    await guardMutation('save', () => Promise.reject(new Error('nope')))();
    expect(seen).toEqual([]);
  });
});
