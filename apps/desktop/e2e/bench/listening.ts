import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Heard, heardFromSegments, type TranscriptSegment } from '@calendar/ai';
import type { HelperClient } from './providers.ts';

/**
 * A recording heard as the app hears a phrase: streamed at the
 * microphone's pace into the helper's listening (`speech.start`,
 * `speech.audio`), then read whole when it ends (`speech.finish`), by
 * Apple's recogniser in the device's language, by the second language's
 * beside it, and by Parakeet with the names the user is likely to say
 * when the run has its files. The Mac's helper runs the Swift the iPhone
 * runs (`SpeechBridge.swift`, `ParakeetBridge.swift`), so it stands in
 * for both.
 */

/** The device a run hears with (the MODEL_BENCH_* variables that say so). */
export interface Device {
  /** The language dictation listens in; each case's own where the run names none. */
  readonly language: string | undefined;
  /** The folder Parakeet's files are in, when the run reads with it. */
  readonly parakeet: string | undefined;
  /** The second language: a locale, `auto` (the helper's Mac decides) or `off`; the bench's other one where the run names none. */
  readonly second: string | undefined;
}

const named = (value: string | undefined): string | undefined => {
  const text = (value ?? '').trim();
  return text === '' ? undefined : text;
};

export const deviceOf = (env: Readonly<Record<string, string | undefined>>): Device => ({
  language: named(env['MODEL_BENCH_LANGUAGE']),
  parakeet: named(env['MODEL_BENCH_PARAKEET']),
  second: named(env['MODEL_BENCH_SECOND_LANGUAGE']),
});

/** The second language beside one listened in, where the run names none: the bench's other one. */
const otherOf = (locale: string): string =>
  locale.toLowerCase().startsWith('de') ? 'en-US' : 'de-DE';

/** A device as a report's settings line names it: two runs heard by two devices are two results. */
export const deviceText = ({ language, parakeet, second }: Device): string =>
  [
    `language ${language ?? "each case's own"}`,
    `second language ${second ?? (language === undefined ? "the bench's other one" : otherOf(language))}`,
    parakeet === undefined ? "Apple's recogniser alone" : 'read with Parakeet',
  ].join(', ');

/** The languages a case is heard in on a device: its own, and the bench's other one as the second. */
export const languagesFor = (
  device: Device,
  caseLocale: string,
): { readonly locale: string; readonly other: string } => {
  const locale = device.language ?? caseLocale;
  return {
    locale,
    other: device.second ?? otherOf(locale),
  };
};

const RATE = 16_000;
const BYTES_PER_SECOND = RATE * 2;
/** A tenth of a second a block, as a microphone hands its audio on. */
const BLOCK_BYTES = BYTES_PER_SECOND / 10;
const BLOCK_MS = 100;
/** The quiet after the last word before a phrase is sent (`phraseEnd.ts` waits about as long). */
const PAUSE_MS = 1000;

/** The samples of a WAV file: its `data` chunk, wherever the chunks before it end. */
export const pcmOfWav = (wav: Buffer): Buffer => {
  if (wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a WAV file');
  }
  let at = 12;
  while (at + 8 <= wav.length) {
    const size = wav.readUInt32LE(at + 4);
    if (wav.toString('ascii', at, at + 4) === 'data') {
      return wav.subarray(at + 8, Math.min(wav.length, at + 8 + size));
    }
    // Chunks are word-aligned: an odd one has a pad byte after it.
    at += 8 + size + (size % 2);
  }
  throw new Error('a WAV file without samples');
};

/** A recording as the listening takes it: 16 kHz, one channel, 16-bit, converted by macOS's afconvert. */
const pcmOf = (path: string): Buffer => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-audio-'));
  try {
    const wav = join(dir, 'clip.wav');
    execFileSync('/usr/bin/afconvert', [
      '-f',
      'WAVE',
      '-d',
      `LEI16@${String(RATE)}`,
      '-c',
      '1',
      path,
      wav,
    ]);
    return pcmOfWav(readFileSync(wav));
  } finally {
    rmSync(dir, { force: true, recursive: true });
  }
};

/** What Parakeet made of a phrase: before the names, the words they replaced, and after. */
export interface ParakeetReading {
  readonly raw: string;
  readonly replacements: ReadonlyArray<{ readonly from: string; readonly to: string }>;
  readonly text: string;
}

/** A recording as it was heard: what the app would send, and Parakeet's own account of its reading. */
export interface Hearing {
  /** Nothing when the recogniser heard no words. */
  readonly heard: Heard | undefined;
  readonly parakeet?: ParakeetReading | undefined;
}

export interface Speech {
  /** Hears a recording in `locale`, `other` beside it, listening for `names` when Parakeet reads. */
  readonly hear: (
    path: string,
    languages: { readonly locale: string; readonly other: string },
    names: ReadonlyArray<string>,
  ) => Promise<Hearing>;
  /** Before the first recording: a run that names Parakeet's folder has its files there, or stops. */
  readonly ready: () => Promise<void>;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

interface Finished {
  readonly other?: string;
  readonly parakeet?: ParakeetReading;
  readonly segments: ReadonlyArray<TranscriptSegment>;
}

/**
 * How often a phrase is said again to a Parakeet that gave no reading: a
 * phrase waits four seconds for it and goes without it (`readLimit`), and
 * its first load after a download takes about half a minute.
 */
const PARAKEET_TRIES = 8;

export const helperSpeech = (
  helper: HelperClient,
  device: Device,
  {
    pace = wait,
    pcm: samplesOf = pcmOf,
  }: {
    /** The wait between two blocks of audio. */
    readonly pace?: (ms: number) => Promise<void>;
    /** A recording's samples: 16 kHz, one channel, 16-bit. */
    readonly pcm?: (path: string) => Buffer;
  } = {},
): Speech => {
  const prepared = new Map<string, Promise<unknown>>();
  let sessions = 0;
  /** The names Parakeet listens for now: told again only when they change. */
  let listeningFor: string | undefined;
  const prepare = (locale: string, other: string): Promise<unknown> => {
    const key = `${locale}+${other}`;
    let waiting = prepared.get(key);
    if (waiting === undefined) {
      waiting = helper.request('prepareSpeech', { locale, other });
      // A failed install is tried again next time, not remembered.
      waiting.catch(() => prepared.delete(key));
      prepared.set(key, waiting);
    }
    return waiting;
  };
  /** One phrase through a listening of its own: streamed, then read whole. */
  const listen = async (
    samples: Buffer,
    { locale, other }: { readonly locale: string; readonly other: string },
  ): Promise<Finished> => {
    const session = ++sessions;
    await helper.request('speech.start', { locale, other, session });
    try {
      // At the microphone's pace: the listening lets go of audio from before the first words it wrote.
      const quiet = Buffer.alloc(BLOCK_BYTES);
      for (let at = 0; at < samples.length; at += BLOCK_BYTES) {
        const block = samples.subarray(at, at + BLOCK_BYTES);
        await helper.request('speech.audio', { pcmBase64: block.toString('base64'), session });
        await pace(BLOCK_MS);
      }
      for (let waited = 0; waited < PAUSE_MS; waited += BLOCK_MS) {
        await helper.request('speech.audio', { pcmBase64: quiet.toString('base64'), session });
        await pace(BLOCK_MS);
      }
    } catch (error) {
      await helper.request('speech.cancel', { session }).catch(() => undefined);
      throw error;
    }
    return (await helper.request('speech.finish', { session })) as Finished;
  };
  return {
    hear: async (path, languages, names) => {
      await prepare(languages.locale, languages.other);
      if (device.parakeet !== undefined) {
        const key = JSON.stringify(names);
        if (key !== listeningFor) {
          await helper.request('parakeet.use', {
            folder: device.parakeet,
            on: true,
            vocabulary: names,
          });
          listeningFor = key;
        }
        // As the app does when a phrase starts: the models load while it is said.
        await helper.request('parakeet.prepare', { folder: device.parakeet });
      }
      const samples = samplesOf(path);
      let result = await listen(samples, languages);
      // Words that Parakeet did not read are Apple's alone, which is another run's result:
      // said again while its models load, and a failed hearing when it never reads.
      for (
        let tries = 1;
        device.parakeet !== undefined &&
        result.segments.length > 0 &&
        result.parakeet === undefined;
        tries += 1
      ) {
        if (tries >= PARAKEET_TRIES) {
          throw new Error(
            `Parakeet gave no reading in ${String(PARAKEET_TRIES)} tries (MODEL_BENCH_PARAKEET=${device.parakeet})`,
          );
        }
        result = await listen(samples, languages);
      }
      return {
        heard: heardFromSegments(result.segments, result.other, result.parakeet?.text),
        ...(result.parakeet === undefined ? {} : { parakeet: result.parakeet }),
      };
    },
    ready: async () => {
      if (device.parakeet === undefined) {
        return;
      }
      const files = (await helper.request('parakeet.state', { folder: device.parakeet })) as {
        readonly here?: boolean;
      };
      if (files.here !== true) {
        throw new Error(
          `MODEL_BENCH_PARAKEET names a folder without Parakeet's files: ${device.parakeet}`,
        );
      }
    },
  };
};
