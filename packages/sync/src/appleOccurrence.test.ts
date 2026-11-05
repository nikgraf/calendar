import { readFileSync } from 'node:fs';
import { APPLE_WRITE_REACH_MS } from '@calendar/apple-calendar';
import { describe, expect, it } from 'vite-plus/test';

describe('APPLE_WRITE_REACH_MS', () => {
  // A read that decides a write must not reach further than the bridge's
  // own lookup: an occurrence it found beyond that would answer notFound
  // to the delete, and that would count as "already gone".
  it("is the window of the bridge's lookup by slot", () => {
    const swift = readFileSync(
      new URL('../../apple-calendar/swift/AppleCalendarBridge.swift', import.meta.url),
      'utf8',
    );
    const lookup = swift.slice(
      swift.indexOf('private func occurrence(id: String, originalStartUtc: Double?)'),
    );
    const days = /let window: TimeInterval = (\d+) \* 24 \* 60 \* 60\n/u.exec(lookup)?.[1];
    expect(days).toBeDefined();
    expect(Number(days) * 24 * 60 * 60 * 1000).toBe(APPLE_WRITE_REACH_MS);
  });
});
