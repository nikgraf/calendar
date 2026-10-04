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

/** The native store as the share extension leaves it. */
const storeWith = (payloads: Array<SharePayload>): SharingModule => {
  let stored = payloads;
  return {
    clearSharedPayloads: () => {
      stored = [];
    },
    getSharedPayloads: () => stored,
  };
};

const { fixtureShareFromUrl, sourceFromPayloads, takeIncomingShare } =
  await import('./incomingShare.ts');
type SharePayload = import('./incomingShare.ts').SharePayload;
type SharingModule = import('./incomingShare.ts').SharingModule;

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

describe('takeIncomingShare', () => {
  it('reports nothing without the native module instead of crashing', () => {
    expect(takeIncomingShare()).toBeUndefined();
  });

  it('takes the payload once and deletes the copied file only on discard', () => {
    const store = storeWith([
      { mimeType: 'image/png', shareType: 'image', value: 'file:///g/IMG.png' },
    ]);
    deleted.length = 0;
    const share = takeIncomingShare(store);
    expect(share?.source).toEqual({
      image: { kind: 'uri', uri: 'file:///g/IMG.png' },
      kind: 'image',
    });
    expect(takeIncomingShare(store)).toBeUndefined();
    expect(deleted).toEqual([]);
    share?.discard();
    expect(deleted).toEqual(['file:///g/IMG.png']);
  });

  it('discards a file it cannot use right away', () => {
    deleted.length = 0;
    expect(
      takeIncomingShare(storeWith([{ shareType: 'video', value: 'file:///g/clip.mov' }])),
    ).toBeUndefined();
    expect(deleted).toEqual(['file:///g/clip.mov']);
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
