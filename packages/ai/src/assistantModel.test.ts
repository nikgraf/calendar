import { describe, expect, it } from 'vite-plus/test';

import {
  assistantModelManifest,
  noticeCopy,
  PUBLISHED_MODEL,
  sizeLabel,
  storedFileName,
} from './assistantModel.ts';

describe('assistantModelManifest', () => {
  it('fetches the published release when nothing points elsewhere', () => {
    expect(assistantModelManifest(undefined)).toBe(PUBLISHED_MODEL);
    expect(assistantModelManifest('  ')).toBe(PUBLISHED_MODEL);
    expect(PUBLISHED_MODEL.url).toBe(
      `https://github.com/nikgraf/calendar-models/releases/download/${PUBLISHED_MODEL.version}/${PUBLISHED_MODEL.file}`,
    );
    expect(PUBLISHED_MODEL.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(sizeLabel(PUBLISHED_MODEL.bytes)).toBe('834 MB');
  });

  it('names a version’s file with the version in front, safe as a file name', () => {
    expect(storedFileName(PUBLISHED_MODEL)).toBe('v1-solunivo-assistant-q8_0.gguf');
    expect(storedFileName({ ...PUBLISHED_MODEL, version: 'v2/beta 1' })).toBe(
      'v2_beta_1-solunivo-assistant-q8_0.gguf',
    );
  });

  it('takes a valid override, and the published release for one that is not', () => {
    const local = {
      bytes: 10,
      file: 'local.gguf',
      sha256: 'ab',
      url: 'http://127.0.0.1:8092/local.gguf',
      version: 'sim-1',
    };
    expect(assistantModelManifest(JSON.stringify(local))).toEqual(local);
    expect(assistantModelManifest('not json')).toBe(PUBLISHED_MODEL);
    expect(assistantModelManifest(JSON.stringify({ ...local, bytes: '10' }))).toBe(PUBLISHED_MODEL);
  });
});

const WIFI = { constrained: false, expensive: false, satisfied: true };
const SIZE = 833_592_288;

describe('noticeCopy', () => {
  it('offers the download, with its size, while it was not agreed to', () => {
    for (const kind of ['unasked', 'declined'] as const) {
      expect(noticeCopy({ kind }, { device: 'iPhone', network: WIFI, size: SIZE })).toMatchObject({
        action: { kind: 'download', label: 'Download (834 MB)' },
        lines: [expect.stringContaining('one-time download of 834 MB, over Wi-Fi')],
      });
    }
  });

  it('offers a new version as an update where an earlier one was downloaded', () => {
    expect(
      noticeCopy(
        { kind: 'unasked', update: true },
        { device: 'Mac', network: undefined, size: SIZE },
      ),
    ).toMatchObject({
      action: { kind: 'download', label: 'Update (834 MB)' },
      lines: [
        'A new version of the Assistant’s model is ready. It runs on this Mac and is a download of 834 MB.',
      ],
    });
  });

  it('shows the progress and that the Assistant will be available soon', () => {
    const copy = noticeCopy(
      { kind: 'downloading', received: 361_000_000, total: SIZE },
      { device: 'iPhone', network: WIFI, size: SIZE },
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
      noticeCopy(waiting, { device: 'iPhone', network: { ...WIFI, expensive: true }, size: SIZE })
        .action,
    ).toEqual({
      kind: 'mobile',
      label: 'Use Mobile Data (834 MB)',
    });
    const lowData = noticeCopy(waiting, {
      device: 'iPhone',
      network: { ...WIFI, constrained: true },
      size: SIZE,
    });
    expect(lowData.lines[0]).toContain('Low Data Mode');
    expect(lowData.action?.label).toBe('Download Now (834 MB)');
    expect(
      noticeCopy(
        { ...waiting, for: 'network' },
        { device: 'iPhone', network: undefined, size: SIZE },
      ).action,
    ).toBeUndefined();
  });

  it('offers Try Again after a failure, and says why a device has no Assistant model', () => {
    expect(
      noticeCopy(
        { kind: 'failed', message: 'Lost.' },
        { device: 'iPhone', network: WIFI, size: SIZE },
      ),
    ).toEqual({
      action: { kind: 'retry', label: 'Try Again' },
      lines: ['The download did not finish: Lost.'],
    });
    expect(
      noticeCopy(
        { kind: 'unsupported', reason: 'memory' },
        { device: 'iPhone', network: WIFI, size: SIZE },
      ).lines[0],
    ).toContain('8 GB');
  });

  it('words the Mac without Wi-Fi, and says why a Mac has none', () => {
    expect(
      noticeCopy({ kind: 'unasked' }, { device: 'Mac', network: undefined, size: SIZE }),
    ).toEqual({
      action: { kind: 'download', label: 'Download (834 MB)' },
      lines: [
        'The Assistant reads what you say with a model that runs on this Mac. It needs a one-time download of 834 MB.',
      ],
    });
    expect(
      noticeCopy(
        { kind: 'unsupported', reason: 'off' },
        { device: 'Mac', network: undefined, size: SIZE },
      ).lines[0],
    ).toContain('switched off');
  });
});
