import { describe, expect, it } from 'vite-plus/test';
import { noticeCopy } from './assistantModelCopy.ts';

const WIFI = { constrained: false, expensive: false, satisfied: true };
const SIZE = 833_592_288;

describe('noticeCopy', () => {
  it('offers the download, with its size, while it was not agreed to', () => {
    for (const kind of ['unasked', 'declined'] as const) {
      expect(noticeCopy({ kind }, { network: WIFI, size: SIZE })).toMatchObject({
        action: { kind: 'download', label: 'Download (834 MB)' },
        lines: [expect.stringContaining('one-time download of 834 MB, over Wi-Fi')],
      });
    }
  });

  it('shows the progress and that the Assistant will be available soon', () => {
    const copy = noticeCopy(
      { kind: 'downloading', received: 361_000_000, total: SIZE },
      { network: WIFI, size: SIZE },
    );
    expect(copy.lines).toEqual([
      'Downloading the Assistant’s model: 43 %',
      'The Assistant will be available soon. You can use the Form meanwhile.',
    ]);
    expect(copy.progress).toBe(43);
    expect(copy.action).toBeUndefined();
  });

  it('offers mobile data while it waits for Wi-Fi, and says so in Low Data Mode', () => {
    const waiting = { for: 'wifi', kind: 'waiting', received: 0, total: SIZE } as const;
    expect(
      noticeCopy(waiting, { network: { ...WIFI, expensive: true }, size: SIZE }).action,
    ).toEqual({
      kind: 'mobile',
      label: 'Use Mobile Data (834 MB)',
    });
    const lowData = noticeCopy(waiting, { network: { ...WIFI, constrained: true }, size: SIZE });
    expect(lowData.lines[0]).toContain('Low Data Mode');
    expect(lowData.action?.label).toBe('Download Now (834 MB)');
    expect(
      noticeCopy({ ...waiting, for: 'network' }, { network: undefined, size: SIZE }).action,
    ).toBeUndefined();
  });

  it('offers Try Again after a failure, and says why a device has no Assistant model', () => {
    expect(noticeCopy({ kind: 'failed', message: 'Lost.' }, { network: WIFI, size: SIZE })).toEqual(
      {
        action: { kind: 'retry', label: 'Try Again' },
        lines: ['The download did not finish: Lost.'],
      },
    );
    expect(
      noticeCopy({ kind: 'unsupported', reason: 'memory' }, { network: WIFI, size: SIZE }).lines[0],
    ).toContain('8 GB');
  });
});
