import { alternativesFor, type Heard } from '@calendar/ai';

/**
 * Another reading of dictated words that changed nothing, which would
 * change something: offered under the answer, never taken unasked.
 */
export interface OtherReading {
  /** What it would do to the draft, as a step's summary says it: "→ 14:00–15:00". */
  readonly does: string;
  readonly text: string;
}

/** Readings tried at most: each is a turn the model reads, one after the other. */
export const READINGS_TRIED = 3;
/** Readings offered at most, the likeliest first. */
export const READINGS_OFFERED = 2;

/**
 * The other readings of dictated words that changed nothing, which would
 * change the draft: the recogniser's own, the likeliest first
 * (`alternativesFor`), each read as the words were (`would`: what it would
 * do, in words, or undefined when it changes nothing either). Two that
 * would do the same are offered once. Nothing here reads what a word
 * means; the model does, as it read the words. Tried one at a time while
 * the answer is still asked for (`stillAsked`), and a reading the model
 * could not read is no reading.
 */
export const otherReadings = async ({
  heard,
  stillAsked,
  utterance,
  would,
}: {
  readonly heard: Heard;
  readonly stillAsked: () => boolean;
  readonly utterance: string;
  readonly would: (text: string) => Promise<string | undefined>;
}): Promise<ReadonlyArray<OtherReading>> => {
  const offered: Array<OtherReading> = [];
  for (const text of alternativesFor(heard, utterance, READINGS_TRIED)) {
    if (!stillAsked() || offered.length >= READINGS_OFFERED) {
      break;
    }
    const does = await would(text).catch(() => undefined);
    if (does !== undefined && !offered.some((reading) => reading.does === does)) {
      offered.push({ does, text });
    }
  }
  return offered;
};
