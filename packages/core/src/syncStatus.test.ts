import { describe, expect, it } from 'vitest';
import { historyStatusLabel } from './syncStatus.ts';

describe('historyStatusLabel', () => {
  it('reports progress while importing, completion after, nothing when empty', () => {
    expect(historyStatusLabel({ eventCount: 12_340, importing: true })).toBe(
      'Importing history… 12,340 events so far',
    );
    expect(historyStatusLabel({ eventCount: 0, importing: true })).toBe(
      'Importing history… 0 events so far',
    );
    expect(historyStatusLabel({ eventCount: 3, importing: false })).toBe('History complete');
    expect(historyStatusLabel({ eventCount: 0, importing: false })).toBeNull();
  });
});
