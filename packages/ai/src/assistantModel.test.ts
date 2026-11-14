import { describe, expect, it } from 'vite-plus/test';

import {
  assistantModelManifest,
  createRowNote,
  lessonModelCopy,
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

describe('lessonModelCopy', () => {
  const iPhone = { device: 'iPhone' as const, network: WIFI, size: SIZE };

  it('says what the Assistant is and what the download is, with the notice’s action', () => {
    const copy = lessonModelCopy({ kind: 'unasked' }, iPhone);
    expect(copy.text).toContain(
      'a small model trained on calendar phrases, running on this iPhone',
    );
    expect(copy.text).toContain('a one-time download of 834 MB, over Wi-Fi');
    expect(copy.action).toEqual({ kind: 'download', label: 'Download (834 MB)' });
    expect(lessonModelCopy({ kind: 'unasked' }, { ...iPhone, device: 'Mac' }).text).not.toContain(
      'Wi-Fi',
    );
  });

  it('counts the download, and keeps the demo in reach while it waits or failed', () => {
    const downloading = lessonModelCopy(
      { kind: 'downloading', received: 350_000_000, total: SIZE },
      iPhone,
    );
    expect(downloading).toMatchObject({ progress: 41 });
    expect(downloading.text).toContain('41 %');
    const failed = lessonModelCopy({ kind: 'failed', message: 'The connection was lost.' }, iPhone);
    expect(failed.action).toEqual({ kind: 'retry', label: 'Try Again' });
    expect(failed.text).toContain('the demo');
    // A message without its own full stop gets one.
    expect(
      lessonModelCopy({ kind: 'failed', message: 'fetch failed' }, { ...iPhone, device: 'Mac' })
        .text,
    ).toContain('did not finish: fetch failed. Meanwhile');
  });

  it('tells waiting for Wi-Fi from waiting out Low Data Mode, as the notice does', () => {
    const waiting = { for: 'wifi' as const, kind: 'waiting' as const, received: 0, total: SIZE };
    expect(
      lessonModelCopy(waiting, {
        ...iPhone,
        network: { constrained: false, expensive: true, satisfied: true },
      }).text,
    ).toContain('downloads when this iPhone is on Wi-Fi');
    expect(
      lessonModelCopy(waiting, {
        ...iPhone,
        network: { constrained: true, expensive: false, satisfied: true },
      }).text,
    ).toContain('waits while Low Data Mode is on');
  });

  it('points an iPhone that cannot run it to the Form, and says when the model is ready', () => {
    expect(lessonModelCopy({ kind: 'unsupported', reason: 'memory' }, iPhone).text).toBe(
      'This iPhone can’t run the Assistant’s model: it needs 8 GB of memory. The demo shows what it does; the Form makes your events.',
    );
    expect(lessonModelCopy({ kind: 'ready', path: '/m' }, iPhone).text).toContain(
      'The Assistant is ready, on this iPhone.',
    );
  });
});

describe('createRowNote', () => {
  it('says where the download stands on the Create row, nothing once the model is ready', () => {
    expect(createRowNote({ kind: 'unasked' }, { device: 'iPhone' })?.subtitle).toBe(
      'Try the demo · the Assistant downloads once',
    );
    expect(
      createRowNote({ kind: 'downloading', received: SIZE / 2, total: SIZE }, { device: 'Mac' }),
    ).toEqual({ asked: true, progress: 50, subtitle: 'Downloading the Assistant · 50 %' });
    expect(
      createRowNote({ kind: 'unsupported', reason: 'memory' }, { device: 'iPhone' })?.subtitle,
    ).toBe('See it in a demo · this iPhone uses the Form');
    expect(createRowNote({ kind: 'ready', path: '/m' }, { device: 'iPhone' })).toBeUndefined();
  });

  it('keeps a download that was asked for on the row, though it waits or failed', () => {
    expect(
      createRowNote(
        { for: 'wifi', kind: 'waiting', received: 0, total: SIZE },
        { device: 'iPhone' },
      ),
    ).toEqual({ asked: true, subtitle: 'The Assistant downloads on Wi-Fi · try the demo' });
    expect(createRowNote({ kind: 'failed', message: 'Offline' }, { device: 'Mac' })).toEqual({
      asked: true,
      subtitle: 'The download did not finish · try the demo',
    });
    expect(createRowNote({ kind: 'declined' }, { device: 'iPhone' })?.asked).toBe(false);
  });
});
