import { Data } from 'effect';

/**
 * An image handed to text recognition. A share on iOS arrives as a file in
 * the app-group container, so a URI avoids reading it into JS; the desktop
 * renderer only ever holds pasted bytes, so it sends base64.
 */
export type ImageInput =
  | { readonly base64: string; readonly kind: 'base64' }
  | { readonly kind: 'uri'; readonly uri: string };

/**
 * On-device OCR: an image in, its text in reading order out. Its own seam
 * rather than an image field on `LanguageModel`, because it stays the path
 * for OS 26 even once the model reads images itself on OS 27, and because a
 * fake recognizer keeps the capture pipeline testable end to end.
 */
export interface TextRecognizer {
  readonly recognizeText: (image: ImageInput) => Promise<string>;
}

/** The image could not be read at all — a format Vision rejects, or a file that is gone. */
export class TextRecognitionError extends Data.TaggedError('TextRecognitionError')<{
  readonly message: string;
}> {}
