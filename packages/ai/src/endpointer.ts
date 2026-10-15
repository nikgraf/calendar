/** What the endpointer heard: someone started speaking, or stopped. */
export type SpeechEvent = 'end' | 'start';

export interface EndpointOptions {
  /**
   * How fast the room's floor falls to a quieter level (time constant):
   * fast, so speech from the first frame — the floor then starts as the
   * speech itself — stands out after the first gap between syllables.
   */
  readonly floorFallMs: number;
  /** How fast it rises to a louder one — slowly, so speech never becomes the floor. */
  readonly floorRiseMs: number;
  /** Nothing quieter is voice, however quiet the room. */
  readonly minSpeechDb: number;
  /** The quiet after speech that ends a phrase. */
  readonly pauseMs: number;
  /** A voiced stretch lasts until the level falls this close to the floor. */
  readonly releaseMarginDb: number;
  /** A level this far above the floor is voice. */
  readonly speechMarginDb: number;
  /** Voiced time before it counts as speech: a cough or a click is shorter. */
  readonly speechMs: number;
}

/**
 * Levels are dBFS: speech near a laptop or a phone reads about -30 to
 * -15, a quiet room -60 to -45. A longer pause lets a thinking speaker
 * finish a sentence; a shorter one feels quicker but cuts "Lunch with
 * Anna … on Thursday" in two.
 */
export const ENDPOINT_DEFAULTS: EndpointOptions = {
  floorFallMs: 50,
  floorRiseMs: 5000,
  minSpeechDb: -50,
  pauseMs: 1300,
  releaseMarginDb: 8,
  speechMarginDb: 12,
  speechMs: 250,
};

/** Below this a reading is digital silence: a stream starting up, or a microphone gating its quiet. */
const SILENT_DB = -100;
/**
 * What digital silence counts as for the floor once the room was heard:
 * a microphone that gates its quiet to zeros has a quiet room, and speech
 * must still stand out against it. Before that, zeros say nothing.
 */
const GATED_DB = -70;

export interface Endpointer {
  /** Speech was confirmed at some point: a phrase worth transcribing. */
  readonly heard: () => boolean;
  /**
   * One level reading in dBFS, taken at `atMs` (any monotonic clock).
   * Returns 'start' once, when speech is confirmed, and 'end' once, after
   * the pause that follows it; nothing after that.
   */
  readonly push: (levelDb: number, atMs: number) => SpeechEvent | undefined;
}

/**
 * Hands-free dictation's ear: decides from the microphone's level alone
 * when a phrase began and when it ended, so a pause sends it without a
 * tap. Energy against the room's own floor rather than a fixed level: a
 * quiet study and a café both work, and a fan that starts mid-phrase
 * becomes the floor within seconds instead of holding the phrase open.
 */
export const createEndpointer = (overrides: Partial<EndpointOptions> = {}): Endpointer => {
  const options = { ...ENDPOINT_DEFAULTS, ...overrides };
  let floor: number | undefined;
  let previousAt: number | undefined;
  let voiced = false;
  let voicedMs = 0;
  let lastVoicedAt: number | undefined;
  let heard = false;
  let ended = false;

  const push = (levelDb: number, atMs: number): SpeechEvent | undefined => {
    if (ended) {
      return undefined;
    }
    const elapsed = previousAt === undefined ? 0 : Math.max(0, atMs - previousAt);
    previousAt = atMs;
    const audible = Number.isFinite(levelDb) && levelDb > SILENT_DB;
    if (floor === undefined) {
      floor = audible ? levelDb : undefined;
    } else {
      const reading = audible ? levelDb : GATED_DB;
      const tau = reading < floor ? options.floorFallMs : options.floorRiseMs;
      floor += (reading - floor) * (1 - Math.exp(-elapsed / tau));
    }
    const enter =
      floor === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(floor + options.speechMarginDb, options.minSpeechDb);
    const threshold = voiced ? enter - (options.speechMarginDb - options.releaseMarginDb) : enter;
    voiced = audible && levelDb >= threshold;

    if (voiced) {
      lastVoicedAt = atMs;
      if (!heard) {
        voicedMs += elapsed;
        if (voicedMs >= options.speechMs) {
          heard = true;
          return 'start';
        }
      }
      return undefined;
    }
    if (lastVoicedAt === undefined) {
      return undefined;
    }
    const quietMs = atMs - lastVoicedAt;
    if (quietMs < options.pauseMs) {
      return undefined;
    }
    if (!heard) {
      // A blip, then quiet: it never was speech.
      voicedMs = 0;
      lastVoicedAt = undefined;
      return undefined;
    }
    ended = true;
    return 'end';
  };

  return { heard: () => heard, push };
};

/** A block of samples' level in dBFS (RMS); -Infinity for digital silence. */
export const levelOf = (samples: ArrayLike<number>): number => {
  if (samples.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  let sum = 0;
  for (let index = 0; index < samples.length; index += 1) {
    const sample = samples[index] ?? 0;
    sum += sample * sample;
  }
  return 10 * Math.log10(sum / samples.length);
};
