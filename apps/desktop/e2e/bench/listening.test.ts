import { describe, expect, it } from 'vite-plus/test';
import { deviceOf, deviceText, languagesFor, pcmOfWav } from './listening.ts';

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
