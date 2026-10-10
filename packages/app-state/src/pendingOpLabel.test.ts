import { describe, expect, it } from 'vite-plus/test';
import { pendingOpLabel } from './pendingOpLabel.ts';

const op = {
  attempts: 0,
  calendarId: 'list-1',
  eventId: 'N3oyb0ljT3l3VjRqYk1vMw',
  kind: 'completeTask' as const,
};

describe('pendingOpLabel', () => {
  it('names the subject by its title, the id only when there is none', () => {
    expect(pendingOpLabel({ ...op, title: 'Pay rent' }).text).toBe('Task · Pay rent');
    expect(pendingOpLabel(op).text).toBe('Task · N3oyb0ljT3l3VjRqYk1vMw');
  });

  it('says why a retried op failed, on one capped line', () => {
    const label = pendingOpLabel({
      ...op,
      attempts: 40,
      lastError: 'ApiUnavailableError: http 503\n    at stack frame',
    });
    expect(label.retry).toBe('retrying (40×)');
    expect(label.reason).toBe('ApiUnavailableError: http 503');
    const long = pendingOpLabel({
      ...op,
      attempts: 1,
      lastError: `GoogleApiError: ${'x'.repeat(400)}`,
    });
    expect(long.reason).toHaveLength(160);
    expect(long.reason?.endsWith('…')).toBe(true);
  });

  it('gives no reason before a failure or while a conflict waits for a choice', () => {
    expect(pendingOpLabel({ ...op, lastError: 'stale' }).reason).toBeNull();
    expect(pendingOpLabel({ ...op, attempts: 3 }).reason).toBeNull();
    const parked = pendingOpLabel({ ...op, attempts: 1, conflict: {}, lastError: '412' });
    expect(parked.reason).toBeNull();
    expect(parked.retry).toBe('changed on Google — choose a version');
  });
});
