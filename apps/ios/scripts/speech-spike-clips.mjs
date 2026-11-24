// Writes apps/ios/src/speechSpikeClips.ts from the recordings' sheet
// (apps/desktop/e2e/bench/audio/README.md: the places set and the short
// turns): each clip's file, the words said, the place said in it and the
// people named in full, which the Speech Spike page (Settings › Advanced)
// fetches and scores on the phone. Run it after the sheet changes, then
// `pnpm fix` for the formatting; speechSpikeClips.test.ts fails until the
// two agree.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..', '..');
const readme = readFileSync(
  join(root, 'apps', 'desktop', 'e2e', 'bench', 'audio', 'README.md'),
  'utf8',
);
const quote = (text) =>
  `'${text.replaceAll('\\', String.raw`\\`).replaceAll("'", String.raw`\'`)}'`;

/** The table rows of one section: its cells, trimmed. */
const rowsOf = (from, to) =>
  readme
    .split(from)[1]
    .split(to)[0]
    .split('\n')
    .map((line) =>
      line
        .trim()
        .replaceAll(/^\||\|$/gu, '')
        .split('|')
        .map((cell) => cell.trim()),
    )
    .filter((cells) => /^\d+$/u.test(cells[0] ?? ''));

/** The people the clips name in full (the sheet's made-up names). */
export const FULL_NAMES = [
  'Stefan Müller',
  'Thomas Karpfeneder',
  'Katharina Gruber',
  'Jörg Hofstätter',
  'Tom Baker',
  'Emily Carter',
  'James Wright',
];

/** Where the sentence names a place by other words than MapKit's name. */
const SAID_PLACE = {
  14: 'Café Hawelka',
  18: 'Hauptbahnhof',
  24: 'Mayer am Pfarrplatz',
  27: 'Plachutta',
  31: 'München',
  37: 'Wollzeile 5',
  39: 'Währinger Straße 46',
  40: 'Praterstraße 1',
};
/** The German sentence of 26 drops the "Zum". */
const SAID_PLACE_DE = { 26: 'Schwarzen Kameel' };
const TURN_PLACES = {
  1: 'Kaffemik',
  10: 'Plachutta',
  12: 'Schweizerhaus',
  15: 'Mariahilfer Straße',
  17: 'Café Prückel',
  2: 'Vienna',
  22: 'Schwedenplatz',
  5: 'Café Sperl',
  8: 'Augarten',
};
/** The short turns said in German; the others are English. */
const GERMAN_TURNS = new Set([17, 18, 19, 20, 21, 22, 23, 24]);

const two = (n) => String(n).padStart(2, '0');
const peopleIn = (said) => FULL_NAMES.filter((name) => said.includes(name));

const clips = [];
const places = rowsOf('## The places set', '## The short turns');
for (const lang of ['en', 'de']) {
  for (const [number, mapkit, english, german] of places) {
    const n = Number(number);
    const said = lang === 'en' ? english : german;
    const place = (lang === 'de' ? SAID_PLACE_DE[n] : undefined) ?? SAID_PLACE[n] ?? mapkit;
    clips.push({
      group: lang,
      id: `place-${lang}-${two(n)}`,
      lang,
      path: `places/place-${lang}-${two(n)}.m4a`,
      place,
      said,
    });
  }
}
for (const [number, said] of rowsOf('## The short turns', '## The scripted phrases')) {
  const n = Number(number);
  clips.push({
    group: 'turns',
    id: `turn-${two(n)}`,
    lang: GERMAN_TURNS.has(n) ? 'de' : 'en',
    path: `turns/turn-${two(n)}.m4a`,
    place: TURN_PLACES[n],
    said,
  });
}

/** The vocabulary's places: each English sentence's, without a house number. */
const spikePlaces = clips
  .filter((clip) => clip.group === 'en')
  .map((clip) => clip.place.replace(/ \d+$/u, ''));

const line = (clip) => {
  const fields = [
    `group: ${quote(clip.group)}`,
    `id: ${quote(clip.id)}`,
    `lang: ${quote(clip.lang)}`,
    `path: ${quote(clip.path)}`,
    `people: [${peopleIn(clip.said).map(quote).join(', ')}]`,
    ...(clip.place === undefined ? [] : [`place: ${quote(clip.place)}`]),
    `said: ${quote(clip.said)}`,
  ];
  return `  { ${fields.join(', ')} },`;
};

writeFileSync(
  join(root, 'apps', 'ios', 'src', 'speechSpikeClips.ts'),
  `/**
 * The recordings the Speech Spike page runs (Settings › Advanced): Nik's
 * clips in \`apps/desktop/e2e/bench/audio/\`, with what the sheet says
 * each one says (\`audio/README.md\`), the place said in it and the people
 * named in full. Written by \`node apps/ios/scripts/speech-spike-clips.mjs\`
 * from the sheet; speechSpikeClips.test.ts holds the two together.
 */

export interface SpikeClip {
  /** The English sentences, the German ones, the short turns. */
  readonly group: 'de' | 'en' | 'turns';
  readonly id: string;
  /** The language the clip is said in. */
  readonly lang: 'de' | 'en';
  /** Under \`apps/desktop/e2e/bench/audio/\`. */
  readonly path: string;
  /** The people the clip names in full. */
  readonly people: ReadonlyArray<string>;
  /** The place as the clip says it, where it says one. */
  readonly place?: string;
  readonly said: string;
}

/** The people the clips name: the vocabulary Parakeet is given (an address book's worth). */
export const SPIKE_PEOPLE: ReadonlyArray<string> = [
${[...FULL_NAMES, 'Sarah', 'Anna', 'Max', 'David'].map((name) => `  ${quote(name)},`).join('\n')}
];

/**
 * The places the English sentences say, a street's number left off: the
 * vocabulary when places are asked for, as a list of the places someone
 * goes to would be. Every place a sentence names is in it (the German
 * sentences say the same ones), so it measures the best case.
 */
export const SPIKE_PLACES: ReadonlyArray<string> = [
${spikePlaces.map((place) => `  ${quote(place)},`).join('\n')}
];

export const SPIKE_CLIPS: ReadonlyArray<SpikeClip> = [
${clips.map(line).join('\n')}
];
`,
);
