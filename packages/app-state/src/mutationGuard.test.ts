import { describe, expect, it } from 'vite-plus/test';
import {
  guardMutation,
  type MutationNotice,
  publishMutationNotice,
  subscribeMutationNotices,
} from './mutationGuard.ts';
import { GOOGLE_TIMED_DROP_NOTICE } from './taskDrop.ts';

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

  it('numbers each publish: one id for every listener, a new one for a repeat', () => {
    const first: Array<number> = [];
    const second: Array<number> = [];
    const stopFirst = subscribeMutationNotices((_, id) => first.push(id));
    const stopSecond = subscribeMutationNotices((_, id) => second.push(id));
    publishMutationNotice(GOOGLE_TIMED_DROP_NOTICE);
    publishMutationNotice(GOOGLE_TIMED_DROP_NOTICE);
    stopFirst();
    stopSecond();
    expect(first).toEqual(second);
    expect(first[1]).toBeGreaterThan(first[0]!);
  });

  it('unsubscribed listeners stop receiving notices', async () => {
    const seen: Array<MutationNotice> = [];
    const unsubscribe = subscribeMutationNotices((notice) => seen.push(notice));
    unsubscribe();
    await guardMutation('save', () => Promise.reject(new Error('nope')))();
    expect(seen).toEqual([]);
  });
});
