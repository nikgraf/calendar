import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const disk = vi.hoisted(() => ({
  copyFails: false,
  deleted: [] as Array<string>,
  files: new Map<string, string>(),
  notices: [] as Array<{ action: string; detail: string }>,
}));
vi.mock('@calendar/app-state', () => ({
  publishMutationNotice: (notice: { action: string; detail: string }) => disk.notices.push(notice),
}));
vi.mock('expo-file-system', () => ({
  File: class {
    readonly uri: string;
    constructor(...parts: Array<string>) {
      this.uri = parts.join('/');
    }
    get extension() {
      return /\.[^./]+$/.exec(this.uri)?.[0] ?? '';
    }
    copySync(destination: { uri: string }) {
      const contents = disk.files.get(this.uri);
      if (contents === undefined) {
        throw new Error('The shared image no longer exists.');
      }
      disk.files.set(destination.uri, contents);
      if (disk.copyFails) {
        throw new Error('Not enough storage.');
      }
    }
    delete() {
      disk.deleted.push(this.uri);
      disk.files.delete(this.uri);
    }
  },
  Paths: { cache: 'file:///cache' },
}));

// A binary built before expo-sharing was a dependency: the package throws
// while being evaluated, exactly as requireNativeModule does.
vi.mock('expo-sharing', () => {
  throw new Error("Cannot find native module 'ExpoSharing'");
});

/** The native store as the share extension leaves it. */
const storeWith = (payloads: Array<SharePayload>): SharingModule => {
  let stored = payloads;
  for (const payload of payloads) {
    if (payload.shareType !== 'text' && payload.shareType !== 'url') {
      disk.files.set(payload.value, `contents of ${payload.value}`);
    }
  }
  return {
    clearSharedPayloads: () => {
      stored = [];
      // expo-sharing 58.0.23 clears the entire app-group share cache,
      // including files whose capture may still be running.
      for (const uri of disk.files.keys()) {
        if (uri.startsWith('file:///g/')) {
          disk.files.delete(uri);
        }
      }
    },
    getSharedPayloads: () => stored,
  };
};

const { fixtureShareFromUrl, settingsCodeOf, sourceFromPayloads, takeIncomingShare } =
  await import('./incomingShare.ts');
type SharePayload = import('./incomingShare.ts').SharePayload;
type SharingModule = import('./incomingShare.ts').SharingModule;

beforeEach(() => {
  disk.copyFails = false;
  disk.deleted.length = 0;
  disk.files.clear();
  disk.notices.length = 0;
});

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

  it('keeps the image readable after clearing the inbox and deletes its copy on discard', () => {
    const store = storeWith([
      { mimeType: 'image/png', shareType: 'image', value: 'file:///g/IMG.png' },
    ]);
    const share = takeIncomingShare(store);
    const uri =
      share?.source.kind === 'image' && share.source.image.kind === 'uri'
        ? share.source.image.uri
        : '';
    expect(share?.source).toEqual({
      image: { kind: 'uri', uri },
      kind: 'image',
    });
    expect(takeIncomingShare(store)).toBeUndefined();
    expect(disk.files.has('file:///g/IMG.png')).toBe(false);
    expect(disk.files.get(uri)).toBe('contents of file:///g/IMG.png');
    expect(uri).toMatch(/^file:\/\/\/cache\/incoming-share-.+\.png$/);
    share?.discard();
    expect(disk.files.has(uri)).toBe(false);
    expect(() => share?.discard()).not.toThrow();
  });

  it('discards a file it cannot use right away', () => {
    expect(
      takeIncomingShare(storeWith([{ shareType: 'video', value: 'file:///g/clip.mov' }])),
    ).toBeUndefined();
    expect(disk.files.size).toBe(0);
  });

  it('keeps overlapping captures independent when another inbox is cleared', () => {
    const first = takeIncomingShare(
      storeWith([{ shareType: 'image', value: 'file:///g/IMG.png' }]),
    );
    const second = takeIncomingShare(
      storeWith([{ shareType: 'image', value: 'file:///g/IMG.png' }]),
    );
    const uriOf = (share: typeof first) =>
      share?.source.kind === 'image' && share.source.image.kind === 'uri'
        ? share.source.image.uri
        : '';
    const firstUri = uriOf(first);
    const secondUri = uriOf(second);
    expect(firstUri).not.toBe(secondUri);
    expect(disk.files.has(firstUri)).toBe(true);
    expect(disk.files.has(secondUri)).toBe(true);
    first?.discard();
    expect(disk.files.has(firstUri)).toBe(false);
    expect(disk.files.has(secondUri)).toBe(true);
    second?.discard();
    expect(disk.files.size).toBe(0);
  });

  it('cleans up a partial copy and keeps the inbox for retry when copying fails', () => {
    const store = storeWith([{ shareType: 'image', value: 'file:///g/IMG.png' }]);
    disk.copyFails = true;
    expect(takeIncomingShare(store)).toBeUndefined();
    expect(store.getSharedPayloads()).toHaveLength(1);
    expect([...disk.files.keys()]).toEqual(['file:///g/IMG.png']);
    expect(disk.notices).toEqual([
      { action: 'read the shared content', detail: 'Try sharing it again.' },
    ]);
    disk.copyFails = false;
    const share = takeIncomingShare(store);
    expect(share?.source.kind).toBe('image');
    share?.discard();
    expect(disk.files.size).toBe(0);
  });

  it('cleans up the retained copy if clearing the native inbox fails', () => {
    const store = storeWith([{ shareType: 'image', value: 'file:///g/IMG.png' }]);
    expect(
      takeIncomingShare({
        ...store,
        clearSharedPayloads: () => {
          throw new Error('Native failure');
        },
      }),
    ).toBeUndefined();
    expect([...disk.files.keys()]).toEqual(['file:///g/IMG.png']);
    expect(store.getSharedPayloads()).toHaveLength(1);
    expect(disk.notices).toHaveLength(1);
  });

  it('takes shared text without copying any file', () => {
    const store = storeWith([{ shareType: 'text', value: 'Lunch tomorrow' }]);
    const share = takeIncomingShare(store);
    expect(share?.source).toEqual({ kind: 'text', text: 'Lunch tomorrow' });
    expect(takeIncomingShare(store)).toBeUndefined();
    share?.discard();
    expect(disk.deleted).toEqual([]);
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

describe('settingsCodeOf', () => {
  it('finds a settings code in shared text, and nothing in an image or plain text', () => {
    expect(
      settingsCodeOf({ kind: 'text', text: 'From the Mac:\nSOLUNIVO:1:MZXW6YTBOIMZXW6YTBOI\n' }),
    ).toBe('SOLUNIVO:1:MZXW6YTBOIMZXW6YTBOI');
    expect(settingsCodeOf({ kind: 'text', text: 'Lunch with Sam tomorrow at 12:30' })).toBeNull();
    expect(
      settingsCodeOf({ image: { kind: 'uri', uri: 'file:///group/a.png' }, kind: 'image' }),
    ).toBeNull();
  });
});
