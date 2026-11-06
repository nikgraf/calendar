import { readFileSync } from 'node:fs';
import { APPLE_WRITE_REACH_MS } from '@calendar/apple-calendar';
import { describe, expect, it } from 'vite-plus/test';

describe('APPLE_WRITE_REACH_MS', () => {
  // The fake looks for a slot as far as the bridge does, and the client
  // reads as far around a slot for an occurrence its identifier no longer
  // names: one number, the bridge's.
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
