import { describe, expect, it } from 'vite-plus/test';
import { askAgain } from './placeLookup.ts';

/** A lookup that answers with each of `answers` in turn, and counts its tries and pauses. */
const lookup = (answers: ReadonlyArray<ReadonlyArray<string>>) => {
  let asked = 0;
  const pauses: Array<number> = [];
  return {
    ask: () => {
      const failures = answers[Math.min(asked, answers.length - 1)] ?? [];
      asked += 1;
      return Promise.resolve({ failures, tried: asked });
    },
    asked: () => asked,
    pause: (ms: number) => {
      pauses.push(ms);
      return Promise.resolve();
    },
    pauses,
  };
};

describe('askAgain', () => {
  it('takes an answer none of whose calls failed, without asking twice', async () => {
    const clean = lookup([[]]);
    expect(await askAgain(clean.ask, { pause: clean.pause })).toEqual({ failures: [], tried: 1 });
    expect(clean.pauses).toEqual([]);
  });

  it('asks again after a pause while a call fails, and takes the first clean answer', async () => {
    const lost = lookup([['geo.search: failed: The network connection was lost.'], []]);
    expect(await askAgain(lost.ask, { pause: lost.pause })).toEqual({ failures: [], tried: 2 });
    expect(lost.pauses).toEqual([30_000]);
  });

  it('gives up after its tries and reports what the last one could not reach', async () => {
    const down = lookup([['geo.resolve: no answer in time']]);
    expect(await askAgain(down.ask, { pause: down.pause })).toEqual({
      failures: ['geo.resolve: no answer in time'],
      tried: 3,
    });
    expect(down.asked()).toBe(3);
    // No pause after the last try.
    expect(down.pauses).toEqual([30_000, 30_000]);
  });
});
