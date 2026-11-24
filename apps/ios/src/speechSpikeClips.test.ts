import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vite-plus/test';
import { SPIKE_CLIPS, SPIKE_PEOPLE, SPIKE_PLACES } from './speechSpikeClips.ts';

const AUDIO = join(import.meta.dirname, '..', '..', 'desktop', 'e2e', 'bench', 'audio');
const sheet = readFileSync(join(AUDIO, 'README.md'), 'utf8');

/** Every table row's cells, in the order the sheet has them. */
const rows = sheet
  .split('\n')
  .map((line) =>
    line
      .trim()
      .replaceAll(/^\||\|$/gu, '')
      .split('|')
      .map((cell) => cell.trim()),
  )
  .filter((cells) => /^\d+$/u.test(cells[0] ?? ''));

// A difference: run `node apps/ios/scripts/speech-spike-clips.mjs`.
describe('SPIKE_CLIPS', () => {
  it('is every recording of the places set and the short turns, as the sheet says it', () => {
    expect(SPIKE_CLIPS).toHaveLength(104);
    for (const clip of SPIKE_CLIPS) {
      expect(existsSync(join(AUDIO, clip.path)), clip.path).toBe(true);
      expect(
        rows.some((cells) => cells.includes(clip.said)),
        clip.id,
      ).toBe(true);
    }
  });

  it('lists every place an English sentence says, its house number left off', () => {
    const english = SPIKE_CLIPS.filter((clip) => clip.group === 'en');
    expect(SPIKE_PLACES).toHaveLength(english.length);
    for (const clip of english) {
      expect(SPIKE_PLACES, clip.id).toContain(clip.place?.replace(/ \d+$/u, ''));
    }
  });

  it('names a place and people that are among the words said', () => {
    for (const clip of SPIKE_CLIPS) {
      if (clip.place !== undefined) {
        expect(clip.said, clip.id).toContain(clip.place);
      }
      for (const person of clip.people) {
        expect(clip.said, clip.id).toContain(person);
        expect(SPIKE_PEOPLE).toContain(person);
      }
    }
  });
});
