import { describe, expect, it } from 'vite-plus/test';
import { seriesEditLossSummary } from './seriesEditLoss.ts';

describe('seriesEditLossSummary', () => {
  it('asks nothing when the save keeps every occurrence', () => {
    expect(seriesEditLossSummary({ changed: 0, deleted: 0 })).toBeNull();
  });

  it('names the occurrences that lose their own changes', () => {
    expect(seriesEditLossSummary({ changed: 1, deleted: 0 })).toBe(
      'Saving this for all events undoes the changes you made to 1 single occurrence.',
    );
    expect(seriesEditLossSummary({ changed: 3, deleted: 0 })).toBe(
      'Saving this for all events undoes the changes you made to 3 single occurrences.',
    );
  });

  it('names the deleted days that come back', () => {
    expect(seriesEditLossSummary({ changed: 0, deleted: 2 })).toBe(
      'Saving this for all events brings back 2 single occurrences you deleted.',
    );
    expect(seriesEditLossSummary({ changed: 2, deleted: 1 })).toBe(
      'Saving this for all events undoes the changes you made to 2 single occurrences and brings back 1 you deleted.',
    );
  });
});
