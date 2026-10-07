import { Temporal } from '@calendar/core';
import { CAPTURE_TEXT_MARKER, type CaptureItemParse, type CaptureParse } from './capture.ts';
import type { LanguageModel } from './model.ts';
import { QUICK_ADD_PHRASE_MARKER, type QuickAddParse } from './quickAdd.ts';
import { TextRecognitionError, type ImageInput, type TextRecognizer } from './textRecognition.ts';

/**
 * A stand-in for the on-device model that both e2e suites can run on any
 * machine. It does no language work: the input is written in a tiny
 * grammar, one event per line —
 *
 *     Title | +N or YYYY-MM-DD | HH:MM-HH:MM | Location
 *
 * — and `+N` counts days from the prompt's "Today is" line, so a spec
 * never computes a date. A quick-add phrase in the same grammar yields one
 * event; any other phrase becomes a title on its own, which the normalizer
 * places on the fallback day as an all-day event.
 */

const TODAY = /Today is (\d{4}-\d{2}-\d{2})/;
const RELATIVE_DAY = /^\+(\d+)$/;
const TIME_RANGE = /^(\d{2}:\d{2})(?:-(\d{2}:\d{2}))?$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseLine = (line: string, referenceDate: string): CaptureItemParse | undefined => {
  const [title = '', when = '', time = '', location = ''] = line
    .split('|')
    .map((part) => part.trim());
  if (!title) {
    return undefined;
  }
  const relative = RELATIVE_DAY.exec(when);
  const date = relative
    ? Temporal.PlainDate.from(referenceDate)
        .add({ days: Number(relative[1]) })
        .toString()
    : when || undefined;
  const range = TIME_RANGE.exec(time);
  return {
    title,
    ...(date ? { date } : {}),
    ...(range ? { startTime: range[1] } : {}),
    ...(range?.[2] ? { endTime: range[2] } : {}),
    ...(location ? { location } : {}),
  };
};

const referenceDateOf = (prompt: string): string => {
  const match = TODAY.exec(prompt);
  if (!match?.[1]) {
    throw new Error('fixture model: the prompt names no reference date');
  }
  return match[1];
};

const textAfter = (prompt: string, marker: string): string => {
  const index = prompt.indexOf(marker);
  if (index === -1) {
    throw new Error(`fixture model: the prompt has no "${marker.trim()}" marker`);
  }
  return prompt.slice(index + marker.length);
};

export const makeFixtureLanguageModel = (): LanguageModel => ({
  generateJson: async ({ jsonSchema, prompt }) => {
    const properties = isRecord(jsonSchema) ? jsonSchema.properties : undefined;
    const referenceDate = referenceDateOf(prompt);
    if (isRecord(properties) && 'events' in properties) {
      const events = textAfter(prompt, CAPTURE_TEXT_MARKER)
        .split('\n')
        .map((line) => parseLine(line, referenceDate))
        .filter((item): item is CaptureItemParse => item !== undefined);
      return { events } satisfies CaptureParse;
    }
    if (isRecord(properties) && 'startTime' in properties) {
      const full = textAfter(prompt, QUICK_ADD_PHRASE_MARKER).trim();
      // "todo: …" is the fixture's deterministic task marker.
      const task = /^todo:\s*/i.exec(full);
      const phrase = task ? full.slice(task[0].length) : full;
      const parsed: QuickAddParse = (phrase.includes('|')
        ? parseLine(phrase, referenceDate)
        : undefined) ?? { title: phrase };
      return task ? { ...parsed, kind: 'task' } : parsed;
    }
    throw new Error('fixture model: unsupported schema');
  },
  status: async () => 'ready',
});

/**
 * "Recognises" an image whose bytes are UTF-8 text — a spec pastes a text
 * file as an image and the whole image path runs without Vision.
 */
export const fixtureTextRecognizer: TextRecognizer = {
  recognizeText: async (image: ImageInput) => {
    if (image.kind !== 'base64') {
      throw new TextRecognitionError({ message: 'The fixture recognizer reads base64 only.' });
    }
    try {
      const bytes = Uint8Array.from(atob(image.base64), (char) => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      throw new TextRecognitionError({ message: 'Not base64.' });
    }
  },
};
