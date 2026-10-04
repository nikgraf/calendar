import {
  buildCapturePrompt,
  CAPTURE_JSON_SCHEMA,
  normalizeCapture,
  prepareCaptureText,
  type CaptureParse,
} from './capture.ts';
import { ModelUnavailableError, type LanguageModel } from './model.ts';
import type { QuickAddPrefill } from './normalizeQuickAdd.ts';
import type { ImageInput, TextRecognizer } from './textRecognition.ts';

/** What the user pasted or shared. */
export type CaptureSource =
  | { readonly image: ImageInput; readonly kind: 'image' }
  | { readonly kind: 'text'; readonly text: string };

/** The two slow steps, so a UI can say which one it is waiting on. */
export type CapturePhase = 'extracting' | 'reading';

export type CaptureResult =
  | {
      readonly drafts: ReadonlyArray<QuickAddPrefill>;
      readonly kind: 'parsed';
      /** The source was longer than the model can take; the tail was dropped. */
      readonly truncated: boolean;
    }
  | { readonly kind: 'rejected'; readonly reason: string };

const UNREADABLE = "That couldn't be read — try again or paste the text instead.";

/**
 * A text or an image in, editor prefills out. Only OCR and the model call
 * are impure; text preparation, prompt building and normalization are pure
 * around them, so the whole path runs against fakes in tests.
 *
 * Reading an image on OS 27 can later skip OCR and hand the image to the
 * model itself — that is one more branch here, nothing above changes.
 */
export const parseCapture = async (
  { model, recognizer }: { model: LanguageModel; recognizer: TextRecognizer },
  source: CaptureSource,
  {
    onPhase,
    referenceDate,
    timeZone,
  }: {
    onPhase?: ((phase: CapturePhase) => void) | undefined;
    referenceDate: string;
    timeZone: string;
  },
): Promise<CaptureResult> => {
  if ((await model.status()) !== 'ready') {
    throw new ModelUnavailableError({ message: 'No on-device model is available.' });
  }

  let raw: string;
  if (source.kind === 'image') {
    onPhase?.('reading');
    try {
      raw = await recognizer.recognizeText(source.image);
    } catch {
      return { kind: 'rejected', reason: "That image couldn't be read." };
    }
    if (!raw.trim()) {
      return { kind: 'rejected', reason: 'No text was found in the image.' };
    }
  } else {
    raw = source.text;
  }

  const { text, truncated } = prepareCaptureText(raw);
  if (!text) {
    return { kind: 'rejected', reason: 'There was nothing to read.' };
  }

  onPhase?.('extracting');
  let parsed: unknown;
  try {
    parsed = await model.generateJson({
      jsonSchema: CAPTURE_JSON_SCHEMA,
      prompt: buildCapturePrompt({ referenceDate, text, timeZone }),
    });
  } catch {
    return { kind: 'rejected', reason: UNREADABLE };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'rejected', reason: UNREADABLE };
  }
  const drafts = normalizeCapture(parsed as CaptureParse, {
    referenceDate,
    sourceText: text,
    timeZone,
  });
  if (drafts.length === 0) {
    return { kind: 'rejected', reason: 'No dated events were found.' };
  }
  return { drafts, kind: 'parsed', truncated };
};
