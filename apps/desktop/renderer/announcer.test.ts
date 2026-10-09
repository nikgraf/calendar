import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { makeAnnouncer } from './announcer.ts';

describe('makeAnnouncer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits before it speaks, so the live region is registered first', () => {
    const heard: Array<ReadonlyArray<string>> = [];
    const announcer = makeAnnouncer(100, (texts) => heard.push(texts));
    announcer.say('A');
    vi.advanceTimersByTime(99);
    expect(heard).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(heard).toEqual([['A']]);
  });

  it('keeps a text that is still waiting when another arrives', () => {
    // Two conflicts parking in separate updates 50 ms apart: each was told
    // once by the announce-once rule, so dropping the first loses it.
    const heard: Array<ReadonlyArray<string>> = [];
    const announcer = makeAnnouncer(100, (texts) => heard.push(texts));
    announcer.say('A');
    vi.advanceTimersByTime(50);
    announcer.say('B');
    vi.advanceTimersByTime(100);
    expect(heard.flat()).toEqual(['A', 'B']);
    // Delivered together, within the first one's delay: a steady stream
    // cannot hold the first back.
    expect(heard).toEqual([['A', 'B']]);
  });

  it('says nothing after it is stopped', () => {
    const heard: Array<ReadonlyArray<string>> = [];
    const announcer = makeAnnouncer(100, (texts) => heard.push(texts));
    announcer.say('A');
    announcer.stop();
    vi.advanceTimersByTime(200);
    expect(heard).toEqual([]);
  });
});
