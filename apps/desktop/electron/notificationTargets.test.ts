import { describe, expect, it } from 'vitest';
import { makeNotificationTargets } from './notificationTargets.ts';

const target = {
  accountId: 'acc',
  calendarId: 'cal',
  eventId: 'ev',
  kind: 'event',
  startUtc: 1,
} as const;

describe('makeNotificationTargets', () => {
  it('shows the window, pushes, and hands the target over once', () => {
    const calls: Array<string> = [];
    const targets = makeNotificationTargets({
      push: () => calls.push('push'),
      showWindow: () => calls.push('show'),
    });
    targets.open(target);
    expect(calls).toEqual(['show', 'push']);
    expect(targets.take()).toEqual(target);
    expect(targets.take()).toBeNull();
  });

  it('a click without a target only shows the window, and drops one not taken yet', () => {
    const calls: Array<string> = [];
    const targets = makeNotificationTargets({
      push: () => calls.push('push'),
      showWindow: () => calls.push('show'),
    });
    targets.open(target);
    targets.open(undefined);
    expect(calls).toEqual(['show', 'push', 'show']);
    expect(targets.take()).toBeNull();
  });
});
