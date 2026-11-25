import { describe, expect, it } from 'vite-plus/test';
import { deviceOf, deviceText, helperSpeech, languagesFor, pcmOfWav } from './listening.ts';
import type { HelperClient } from './providers.ts';

const chunk = (id: string, body: Buffer): Buffer => {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  // An odd chunk is followed by a pad byte.
  return Buffer.concat([head, body, Buffer.alloc(body.length % 2)]);
};

const wav = (...chunks: ReadonlyArray<Buffer>): Buffer => {
  const body = Buffer.concat([Buffer.from('WAVE', 'ascii'), ...chunks]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
};

describe('pcmOfWav', () => {
  const samples = Buffer.from([1, 2, 3, 4, 5, 6]);

  it('is the data chunk, whatever chunks come before it', () => {
    expect(pcmOfWav(wav(chunk('fmt ', Buffer.alloc(16)), chunk('data', samples)))).toEqual(samples);
    // afconvert writes a filler chunk before the samples; an odd one is padded.
    expect(
      pcmOfWav(
        wav(
          chunk('fmt ', Buffer.alloc(16)),
          chunk('FLLR', Buffer.alloc(7)),
          chunk('data', samples),
        ),
      ),
    ).toEqual(samples);
  });

  it('stops at the file’s end where the chunk claims more', () => {
    const cut = wav(chunk('fmt ', Buffer.alloc(16)), chunk('data', samples));
    expect(pcmOfWav(cut.subarray(0, cut.length - 2))).toEqual(samples.subarray(0, 4));
  });

  it('refuses what is no WAV file, and one without samples', () => {
    expect(() => pcmOfWav(Buffer.from('not a recording at all'))).toThrow('not a WAV file');
    expect(() => pcmOfWav(wav(chunk('fmt ', Buffer.alloc(16))))).toThrow('without samples');
  });
});

describe('the device a run hears with', () => {
  it('is what the variables name, and nothing for a blank one', () => {
    expect(deviceOf({})).toEqual({ language: undefined, parakeet: undefined, second: undefined });
    expect(
      deviceOf({
        MODEL_BENCH_LANGUAGE: ' en-US ',
        MODEL_BENCH_PARAKEET: '/models/parakeet',
        MODEL_BENCH_SECOND_LANGUAGE: 'off',
      }),
    ).toEqual({ language: 'en-US', parakeet: '/models/parakeet', second: 'off' });
    expect(deviceOf({ MODEL_BENCH_LANGUAGE: '  ' }).language).toBeUndefined();
  });

  it('hears a case in its own language, the bench’s other one beside it', () => {
    const own = deviceOf({});
    expect(languagesFor(own, 'en-US')).toEqual({ locale: 'en-US', other: 'de-DE' });
    expect(languagesFor(own, 'de-DE')).toEqual({ locale: 'de-DE', other: 'en-US' });
  });

  it('hears every case in the language the run names, with the second one it names', () => {
    const english = deviceOf({ MODEL_BENCH_LANGUAGE: 'en-US' });
    expect(languagesFor(english, 'de-DE')).toEqual({ locale: 'en-US', other: 'de-DE' });
    const alone = deviceOf({ MODEL_BENCH_LANGUAGE: 'de-AT', MODEL_BENCH_SECOND_LANGUAGE: 'off' });
    expect(languagesFor(alone, 'en-US')).toEqual({ locale: 'de-AT', other: 'off' });
  });

  it('is named in a report’s settings', () => {
    expect(deviceText(deviceOf({}))).toBe(
      "language each case's own, second language the bench's other one, Apple's recogniser alone",
    );
    expect(
      deviceText(deviceOf({ MODEL_BENCH_LANGUAGE: 'en-US', MODEL_BENCH_PARAKEET: '/models' })),
    ).toBe('language en-US, second language de-DE, read with Parakeet');
  });
});

/** A helper that answers each finished phrase with the next of `readings`, and keeps what it was asked. */
const helperWith = (
  readings: ReadonlyArray<Record<string, unknown>>,
  { here = true }: { readonly here?: boolean } = {},
) => {
  const asked: Array<{ readonly method: string; readonly params: Record<string, unknown> }> = [];
  let finished = 0;
  const helper: HelperClient = {
    close: () => undefined,
    request: (method, params) => {
      asked.push({ method, params });
      if (method === 'speech.finish') {
        const reading = readings[Math.min(finished, readings.length - 1)];
        finished += 1;
        return Promise.resolve(reading);
      }
      return Promise.resolve(method === 'parakeet.state' ? { bytes: 1, here } : {});
    },
  };
  return { asked, helper, methods: () => asked.map((each) => each.method) };
};

const LANGUAGES = { locale: 'en-US', other: 'de-DE' };
const APPLE = { segments: [{ text: 'Lunch at Figelmuller' }] };
const BOTH = {
  ...APPLE,
  parakeet: { raw: 'Lunch at Fiegelmüller', replacements: [], text: 'Lunch at Fiegelmüller' },
};
// A fifth of a second of audio: two blocks, then the pause's ten.
const quick = { pace: () => Promise.resolve(), pcm: () => Buffer.alloc(6400) };

describe('helperSpeech', () => {
  it('streams a recording into a listening of its own and reads it when it ends', async () => {
    const { asked, helper, methods } = helperWith([APPLE]);
    const speech = helperSpeech(helper, deviceOf({}), quick);
    const hearing = await speech.hear('clip.m4a', LANGUAGES, ['Tom Baker']);
    expect(hearing.heard?.text).toBe('Lunch at Figelmuller');
    expect(hearing.parakeet).toBeUndefined();
    expect(methods()).toEqual([
      'prepareSpeech',
      'speech.start',
      ...Array.from({ length: 12 }, () => 'speech.audio'),
      'speech.finish',
    ]);
    expect(asked[1]?.params).toEqual({ locale: 'en-US', other: 'de-DE', session: 1 });
    // A second recording is a second listening; the languages are prepared once.
    await speech.hear('next.m4a', LANGUAGES, ['Tom Baker']);
    expect(methods().filter((method) => method === 'prepareSpeech')).toHaveLength(1);
    expect(asked.findLast((each) => each.method === 'speech.start')?.params['session']).toBe(2);
  });

  it('tells Parakeet the names and loads it before each phrase, as the app does', async () => {
    const { asked, helper, methods } = helperWith([BOTH]);
    const device = deviceOf({ MODEL_BENCH_PARAKEET: '/models' });
    const speech = helperSpeech(helper, device, quick);
    const hearing = await speech.hear('clip.m4a', LANGUAGES, ['Tom Baker']);
    // Parakeet's words are the phrase, Apple's go along.
    expect(hearing.heard?.text).toBe('Lunch at Fiegelmüller');
    expect(hearing.heard?.apple).toBe('Lunch at Figelmuller');
    expect(methods().slice(0, 4)).toEqual([
      'prepareSpeech',
      'parakeet.use',
      'parakeet.prepare',
      'speech.start',
    ]);
    expect(asked[1]?.params).toEqual({ folder: '/models', on: true, vocabulary: ['Tom Baker'] });
    // The same names are not told again; the load is asked for at every phrase.
    await speech.hear('next.m4a', LANGUAGES, ['Tom Baker']);
    await speech.hear('other.m4a', LANGUAGES, ['Anna Lee']);
    expect(methods().filter((method) => method === 'parakeet.use')).toHaveLength(2);
    expect(methods().filter((method) => method === 'parakeet.prepare')).toHaveLength(3);
  });

  it('says a phrase again to a Parakeet still loading, and never passes Apple’s words off as its reading', async () => {
    const loading = helperWith([APPLE, APPLE, BOTH]);
    const device = deviceOf({ MODEL_BENCH_PARAKEET: '/models' });
    const hearing = await helperSpeech(loading.helper, device, quick).hear('c.m4a', LANGUAGES, []);
    expect(hearing.heard?.text).toBe('Lunch at Fiegelmüller');
    expect(loading.methods().filter((method) => method === 'speech.finish')).toHaveLength(3);
    // It never reads: the hearing fails, so the turn runs as its transcript and is counted so.
    const never = helperWith([APPLE]);
    await expect(
      helperSpeech(never.helper, device, quick).hear('c.m4a', LANGUAGES, []),
    ).rejects.toThrow('Parakeet gave no reading in 8 tries');
    expect(never.methods().filter((method) => method === 'speech.finish')).toHaveLength(8);
    // Silence has no reading of anyone's: nothing to say again.
    const silent = helperWith([{ segments: [] }]);
    const nothing = await helperSpeech(silent.helper, device, quick).hear('c.m4a', LANGUAGES, []);
    expect(nothing.heard).toBeUndefined();
    expect(silent.methods().filter((method) => method === 'speech.finish')).toHaveLength(1);
  });

  it('stops a run whose Parakeet folder holds no files, and asks nothing without one', async () => {
    const device = deviceOf({ MODEL_BENCH_PARAKEET: '/models' });
    await expect(
      helperSpeech(helperWith([], { here: false }).helper, device).ready(),
    ).rejects.toThrow("MODEL_BENCH_PARAKEET names a folder without Parakeet's files: /models");
    await expect(helperSpeech(helperWith([]).helper, device).ready()).resolves.toBeUndefined();
    const alone = helperWith([]);
    await helperSpeech(alone.helper, deviceOf({})).ready();
    expect(alone.asked).toEqual([]);
  });

  it('lets go of a listening whose audio could not be sent', async () => {
    const { asked, helper } = helperWith([APPLE]);
    const failing: HelperClient = {
      close: helper.close,
      request: (method, params) =>
        method === 'speech.audio'
          ? Promise.reject(new Error('helper exited (1)'))
          : helper.request(method, params),
    };
    await expect(
      helperSpeech(failing, deviceOf({}), quick).hear('c.m4a', LANGUAGES, []),
    ).rejects.toThrow('helper exited (1)');
    expect(asked.map((each) => each.method)).toEqual([
      'prepareSpeech',
      'speech.start',
      'speech.cancel',
    ]);
  });
});
