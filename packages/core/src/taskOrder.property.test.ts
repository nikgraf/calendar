import { expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { positionBetween } from './taskOrder.ts';

const Ordinal = Schema.Int.check(Schema.isBetween({ maximum: 999_999, minimum: 0 }));
const Insertions = Schema.Array(Schema.Boolean).check(Schema.isBetweenLength(1, 150));

it.prop(
  'positions remain strictly ordered through generated insertions into the same gap',
  { insertions: Insertions, ordinal: Ordinal },
  ({ insertions, ordinal }) => {
    let low = String(ordinal).padStart(20, '0');
    let high = String(ordinal + 1).padStart(20, '0');
    const keys = [low, high];
    for (const before of insertions) {
      const key = positionBetween(low, high);
      expect(key > low && key < high).toBe(true);
      expect(key).toMatch(/^[-0-9]+[0-9]$/u);
      keys.push(key);
      if (before) {
        high = key;
      } else {
        low = key;
      }
    }
    expect(new Set(keys).size).toBe(keys.length);
  },
  { arbitrary: { runs: 150 } },
);

it.prop(
  'unbounded positions keep room for another insertion before and after them',
  { insertions: Insertions },
  ({ insertions }) => {
    let first = '00000000000000000000';
    let last = first;
    for (const before of insertions) {
      if (before) {
        const next = positionBetween(undefined, first);
        expect(next < first).toBe(true);
        const middle = positionBetween(next, first);
        expect(middle > next && middle < first).toBe(true);
        first = next;
      } else {
        const next = positionBetween(last, undefined);
        expect(next > last).toBe(true);
        const middle = positionBetween(last, next);
        expect(middle > last && middle < next).toBe(true);
        last = next;
      }
    }
  },
);
