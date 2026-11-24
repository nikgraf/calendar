import { heardFromSegments } from '@calendar/ai';
import { describe, expect, it } from 'vite-plus/test';
import { otherReadings, READINGS_OFFERED } from './otherReadings.ts';

// "Make it at too", the last word heard with the readings the recogniser weighed for it.
const heard = heardFromSegments([
  { text: 'Make it at' },
  { alternatives: [' too', ' two', ' ten', ' to'], text: ' too' },
])!;

describe('otherReadings', () => {
  it('offers two readings that read alike but leave the draft otherwise both', async () => {
    const readings = await otherReadings({
      heard,
      stillAsked: () => true,
      utterance: heard.text,
      would: async (text) => ({ does: '→ adds a note', effect: text }),
    });
    expect(readings.map((reading) => reading.text)).toEqual(['Make it at two', 'Make it at ten']);
  });

  it('offers the readings that would change something, the likeliest first, each once', async () => {
    const asked: Array<string> = [];
    const readings = await otherReadings({
      heard,
      stillAsked: () => true,
      utterance: heard.text,
      would: async (text) => {
        asked.push(text);
        const does = text.endsWith('two')
          ? '→ 14:00–15:00'
          : text.endsWith('ten')
            ? '→ 10:00–11:00'
            : undefined;
        return does === undefined ? undefined : { does, effect: does };
      },
    });
    expect(asked).toEqual(['Make it at two', 'Make it at ten']);
    expect(readings).toEqual([
      { does: '→ 14:00–15:00', text: 'Make it at two' },
      { does: '→ 10:00–11:00', text: 'Make it at ten' },
    ]);
  });

  it('offers two readings that would leave the draft the same once, and passes over one the model could not read', async () => {
    const readings = await otherReadings({
      heard,
      stillAsked: () => true,
      utterance: heard.text,
      would: async (text) => {
        if (text.endsWith('ten')) {
          throw new Error('model gone');
        }
        return { does: '→ 14:00–15:00', effect: '14:00' };
      },
    });
    expect(readings).toEqual([{ does: '→ 14:00–15:00', text: 'Make it at two' }]);
    expect(readings.length).toBeLessThanOrEqual(READINGS_OFFERED);
  });

  it('offers Apple’s reading first when Parakeet’s was sent', async () => {
    const read = heardFromSegments([{ text: 'Make it at two' }], undefined, 'Make it at too')!;
    const readings = await otherReadings({
      heard: read,
      stillAsked: () => true,
      utterance: read.text,
      would: async (text) => ({ does: '→ 14:00', effect: text }),
    });
    expect(readings.map((reading) => reading.text)).toEqual(['Make it at two']);
  });

  it('stops once the answer is no longer asked for, and has nothing to try for words typed', async () => {
    let asked = 0;
    const readings = await otherReadings({
      heard,
      stillAsked: () => asked === 0,
      utterance: heard.text,
      would: async () => {
        asked += 1;
        return undefined;
      },
    });
    expect(asked).toBe(1);
    expect(readings).toEqual([]);
    const plain = heardFromSegments([{ text: 'Make it at one' }])!;
    await expect(
      otherReadings({
        heard: plain,
        stillAsked: () => true,
        utterance: plain.text,
        would: async () => ({ does: 'x', effect: 'x' }),
      }),
    ).resolves.toEqual([]);
  });
});
