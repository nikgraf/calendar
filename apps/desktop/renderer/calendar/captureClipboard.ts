import type { CaptureSource } from '@calendar/ai';

/**
 * What a paste carried. Read synchronously inside the event handler — a
 * DataTransfer goes inert once the event has been dispatched — and turned
 * into a CaptureSource afterwards, which may involve reading file bytes.
 */
export interface PastedContent {
  readonly image: File | undefined;
  readonly text: string;
}

export const readPaste = (data: DataTransfer | null): PastedContent => {
  const image = data
    ? [...data.items]
        .find((item) => item.kind === 'file' && item.type.startsWith('image/'))
        ?.getAsFile()
    : null;
  return { image: image ?? undefined, text: data?.getData('text/plain') ?? '' };
};

/** A paste worth extracting events from on the grid: any image, or any text at all. */
export const isCapturable = ({ image, text }: PastedContent): boolean =>
  image !== undefined || text.trim().length > 0;

/**
 * Inside the ⌘K input only a paste that cannot be a phrase is taken over:
 * an image, or text spanning lines (an email). A single line pastes into
 * the input like any other text.
 */
export const isCapturableInPhrase = ({ image, text }: PastedContent): boolean =>
  image !== undefined || text.trim().includes('\n');

const toBase64 = (bytes: ArrayBuffer): string => {
  let binary = '';
  for (const byte of new Uint8Array(bytes)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

/** The image wins over text: a screenshot paste often carries its file name as text too. */
export const captureSourceOf = async ({
  image,
  text,
}: PastedContent): Promise<CaptureSource | undefined> => {
  if (image) {
    return {
      image: { base64: toBase64(await image.arrayBuffer()), kind: 'base64' },
      kind: 'image',
    };
  }
  return text.trim() ? { kind: 'text', text } : undefined;
};
