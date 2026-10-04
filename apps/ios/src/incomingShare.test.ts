import type { TextRecognizer } from '@calendar/ai';
import { describe, expect, it, vi } from 'vitest';

const deleted: Array<string> = [];
vi.mock('expo-file-system', () => ({
  File: class {
    constructor(private readonly uri: string) {}
    delete() {
      deleted.push(this.uri);
    }
  },
}));

// A binary built before expo-sharing was a dependency: the package throws
// while being evaluated, exactly as requireNativeModule does.
vi.mock('expo-sharing', () => {
  throw new Error("Cannot find native module 'ExpoSharing'");
});

const { discardingAfterRead, fixtureShareFromUrl, sourceFromPayloads, takeIncomingShare } =
  await import('./incomingShare.ts');

describe('sourceFromPayloads', () => {
  it('prefers the image and ignores a text part beside it', () => {
    expect(
      sourceFromPayloads([
        { shareType: 'text', value: 'IMG_0001.png' },
        { mimeType: 'image/png', shareType: 'image', value: 'file:///group/IMG_0001.png' },
      ]),
    ).toEqual({ image: { kind: 'uri', uri: 'file:///group/IMG_0001.png' }, kind: 'image' });
  });

  it('joins text parts and skips blanks and URLs', () => {
    expect(
      sourceFromPayloads([
        { shareType: 'text', value: ' Standup tomorrow 9 ' },
        { shareType: 'url', value: 'https://example.com' },
        { shareType: 'text', value: '  ' },
        { shareType: 'text', value: 'Planning Friday' },
      ]),
    ).toEqual({ kind: 'text', text: 'Standup tomorrow 9\n\nPlanning Friday' });
    expect(
      sourceFromPayloads([{ shareType: 'url', value: 'https://example.com' }]),
    ).toBeUndefined();
  });
});

describe('takeIncomingShare without the native module', () => {
  it('reports nothing instead of crashing', () => {
    expect(takeIncomingShare()).toBeUndefined();
  });
});

describe('discardingAfterRead', () => {
  const recognizer: TextRecognizer = {
    recognizeText: async (image) => {
      if (image.kind === 'uri' && image.uri.endsWith('bad.png')) {
        throw new Error('vision');
      }
      return 'text';
    },
  };

  it('deletes a shared file whether reading worked or failed, and leaves bytes alone', async () => {
    deleted.length = 0;
    const wrapped = discardingAfterRead(recognizer);
    await expect(wrapped.recognizeText({ kind: 'uri', uri: 'file:///g/ok.png' })).resolves.toBe(
      'text',
    );
    await expect(wrapped.recognizeText({ kind: 'uri', uri: 'file:///g/bad.png' })).rejects.toThrow(
      'vision',
    );
    await wrapped.recognizeText({ base64: 'AA==', kind: 'base64' });
    expect(deleted).toEqual(['file:///g/ok.png', 'file:///g/bad.png']);
  });
});

describe('fixtureShareFromUrl', () => {
  it('decodes the text of a capture-fixture link under any scheme', () => {
    expect(fixtureShareFromUrl('solunivo-dev://capture-fixture?text=Standup%20%7C%20%2B0')).toEqual(
      { kind: 'text', text: 'Standup | +0' },
    );
    expect(fixtureShareFromUrl('solunivo://expo-sharing')).toBeUndefined();
    expect(fixtureShareFromUrl('solunivo-dev://capture-fixture?text=%E0%A4%A')).toBeUndefined();
  });
});
