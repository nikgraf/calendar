import type { CaptureSource } from '@calendar/ai';
import { File } from 'expo-file-system';

/** What the share extension left for the app (expo-sharing's `SharePayload`). */
export interface SharePayload {
  readonly mimeType?: string | undefined;
  readonly shareType: 'audio' | 'file' | 'image' | 'text' | 'url' | 'video';
  /** The text itself, or for a file a `file://` URL inside the app-group container. */
  readonly value: string;
}

export interface SharingModule {
  readonly clearSharedPayloads: () => void;
  readonly getSharedPayloads: () => ReadonlyArray<SharePayload>;
}

/**
 * Importing `expo-sharing` resolves its native module at module evaluation
 * and throws on a binary built before the dependency existed (an older dev
 * client under a newer JS bundle), so it is required lazily, inside a try.
 * Only the raw payload getters are used: the hook reads the native store on
 * every render, and the "resolved" variant makes a network request for a
 * URL share.
 */
const loadSharing = (): SharingModule | undefined => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
    return require('expo-sharing') as SharingModule;
  } catch {
    return undefined;
  }
};

/**
 * The capture source in a share: the image when there is one (a screenshot
 * from Photos often arrives with a text part too), otherwise every text
 * part joined. A web URL alone is nothing to extract from — the page is
 * not fetched — and the activation rule does not offer the extension for
 * one anyway.
 */
export const sourceFromPayloads = (
  payloads: ReadonlyArray<SharePayload>,
): CaptureSource | undefined => {
  const image = payloads.find((payload) => payload.shareType === 'image');
  if (image) {
    return { image: { kind: 'uri', uri: image.value }, kind: 'image' };
  }
  const text = payloads
    .filter((payload) => payload.shareType === 'text')
    .map((payload) => payload.value.trim())
    .filter(Boolean)
    .join('\n\n');
  return text ? { kind: 'text', text } : undefined;
};

/** What the share extension left; `discard` removes any copied files. */
export interface IncomingShare {
  readonly discard: () => void;
  readonly source: CaptureSource;
}

/**
 * Takes what the share extension left, clearing the store so a share is
 * handled once. Clearing only forgets the entry: the extension copied an
 * image into the app-group container and nothing else would ever remove
 * it, so the caller runs `discard` once the capture has ended — whatever
 * its outcome, an unavailable model included.
 */
export const takeIncomingShare = (
  sharing: SharingModule | undefined = loadSharing(),
): IncomingShare | undefined => {
  if (!sharing) {
    return undefined;
  }
  const payloads = sharing.getSharedPayloads();
  if (payloads.length === 0) {
    return undefined;
  }
  sharing.clearSharedPayloads();
  const files = payloads
    .filter((payload) => payload.shareType !== 'text' && payload.shareType !== 'url')
    .map((payload) => payload.value);
  const discard = () => {
    for (const uri of files) {
      try {
        new File(uri).delete();
      } catch {
        // Already gone.
      }
    }
  };
  const source = sourceFromPayloads(payloads);
  if (!source) {
    discard();
    return undefined;
  }
  return { discard, source };
};

/** The e2e flows' stand-in for a share: `solunivo-dev://capture-fixture?text=…`, fixture model only. */
export const fixtureShareFromUrl = (url: string): CaptureSource | undefined => {
  const match = /^[a-z-]+:\/\/capture-fixture\?text=(.*)$/i.exec(url);
  if (!match?.[1]) {
    return undefined;
  }
  try {
    return { kind: 'text', text: decodeURIComponent(match[1]) };
  } catch {
    return undefined;
  }
};
