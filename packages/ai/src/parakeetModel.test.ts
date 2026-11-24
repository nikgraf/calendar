import { describe, expect, it } from 'vite-plus/test';
import { lessonOffer, parakeetCopy, readParakeetChoice } from './parakeetModel.ts';

const ASSISTANT_BYTES = 833_592_288;
const absent = { files: { kind: 'absent' }, on: true } as const;
const offered = {
  action: { kind: 'download', label: 'Download (834 MB)' },
  text: 'Solunivo reads what you say with an Assistant of its own.',
} as const;

describe('lessonOffer', () => {
  it('offers both in one button while Parakeet is on and not here, and a way to go without it', () => {
    expect(
      lessonOffer(offered, absent, { assistantBytes: ASSISTANT_BYTES, device: 'iPhone' }),
    ).toEqual({
      action: { kind: 'both', label: 'Download Both (1.5 GB)' },
      decline: 'Without Parakeet',
      text: 'Solunivo reads what you say with an Assistant of its own. Dictation can also read with Parakeet, a speech model on this iPhone that writes the names and places you say better: 712 MB more.',
    });
  });

  it('offers Parakeet alone once the Assistant’s model is here or under way', () => {
    expect(
      lessonOffer(undefined, absent, { assistantBytes: ASSISTANT_BYTES, device: 'Mac' })?.action,
    ).toEqual({
      kind: 'parakeet',
      label: 'Download Parakeet (712 MB)',
    });
    const downloading = { progress: 40, text: 'Downloading the Assistant’s model · 40 %.' };
    expect(
      lessonOffer(downloading, absent, { assistantBytes: ASSISTANT_BYTES, device: 'Mac' }),
    ).toMatchObject({ action: { kind: 'parakeet' }, decline: 'Without Parakeet', progress: 40 });
  });

  it('is the Assistant’s offer alone once Parakeet is off, here, or not in this build', () => {
    for (const parakeet of [
      { files: { kind: 'absent' }, on: false },
      { files: { bytes: 712_000_000, kind: 'ready' }, on: true },
      { files: { kind: 'unsupported', reason: 'off' }, on: false },
    ] as const) {
      expect(
        lessonOffer(offered, parakeet, { assistantBytes: ASSISTANT_BYTES, device: 'iPhone' }),
      ).toEqual(offered);
      expect(
        lessonOffer(undefined, parakeet, { assistantBytes: ASSISTANT_BYTES, device: 'iPhone' }),
      ).toBeUndefined();
    }
  });

  it('says how far Parakeet is while it downloads', () => {
    const ready = { text: 'The Assistant is ready, on this iPhone.' };
    expect(
      lessonOffer(
        ready,
        { files: { kind: 'downloading', progress: 0.42 }, on: true },
        {
          assistantBytes: ASSISTANT_BYTES,
          device: 'iPhone',
        },
      ),
    ).toEqual({ progress: 42, text: 'The Assistant is ready, on this iPhone. Parakeet: 42 %.' });
  });
});

describe('parakeetCopy', () => {
  it('offers the download, mobile data while it waits for Wi-Fi, and says the room it takes', () => {
    expect(
      parakeetCopy({ kind: 'absent' }, { device: 'iPhone', network: undefined }).action,
    ).toEqual({
      kind: 'download',
      label: 'Download Parakeet (712 MB)',
    });
    expect(
      parakeetCopy(
        { for: 'wifi', kind: 'waiting', progress: 0 },
        { device: 'iPhone', network: { constrained: false, expensive: true, satisfied: true } },
      ),
    ).toEqual({
      action: { kind: 'mobile', label: 'Use Mobile Data (712 MB)' },
      line: 'Parakeet downloads when this iPhone is on Wi-Fi.',
    });
    expect(
      parakeetCopy({ bytes: 711_400_000, kind: 'ready' }, { device: 'Mac', network: undefined }),
    ).toEqual({
      line: 'On this Mac · 711 MB',
    });
  });
});

describe('readParakeetChoice', () => {
  it('is on with nothing asked for unless a choice says otherwise', () => {
    expect(readParakeetChoice(undefined)).toEqual({ on: true });
    expect(readParakeetChoice({ download: 'wifi', on: false })).toEqual({
      download: 'wifi',
      on: false,
    });
    expect(readParakeetChoice({ download: 'anything', on: 'yes' })).toEqual({ on: true });
  });
});
