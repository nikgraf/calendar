import { readFileSync } from 'node:fs';
import { findWords, type TranscriptSegment, wordsOf } from '@calendar/ai';
import { foldSearchText, type PlaceCandidate, preselectedPlace } from '@calendar/core';

/**
 * The place bench's cases (`places.json`): a phrase that names a place,
 * as a recogniser read it in segments with the other readings it weighed
 * for each, the place a model reads in it (the words as written), and
 * the place meant. The bench asks MapKit, through the app's own lookup
 * (`placeCandidates`), for the place as written and then with the
 * readings (`alternativesFor`), and scores whether the place meant was
 * taken, offered, and through which reading.
 */
export interface PlaceCase {
  /** The words as heard, segment by segment: the recogniser's final reading. */
  readonly heard: ReadonlyArray<TranscriptSegment>;
  readonly id: string;
  /** The place as a model reads it in the words: they as written. */
  readonly location: string;
  /** MapKit's names for the place meant: a hit whose name begins with one of them is it. */
  readonly names: ReadonlyArray<string>;
  /** Where the user's places are: a city of `CITIES`. */
  readonly near: string;
  /** What was said. */
  readonly said: string;
  /** Who said it: a `say` voice, or a person on a device. */
  readonly voice: string;
}

/** The cities a case can be near: where the user's two past events are. */
export const CITIES: Readonly<
  Record<string, { readonly lat: number; readonly lng: number; readonly timeZone: string }>
> = {
  vienna: { lat: 48.2082, lng: 16.3738, timeZone: 'Europe/Vienna' },
};

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

const isSegment = (value: unknown): value is TranscriptSegment => {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { alternatives, text } = value as { alternatives?: unknown; text?: unknown };
  return (
    typeof text === 'string' &&
    (alternatives === undefined ||
      (Array.isArray(alternatives) && alternatives.every((each) => typeof each === 'string')))
  );
};

/** One case, checked: a malformed one is named, never run as something else. */
const readCase = (value: unknown, at: number): PlaceCase => {
  const fail = (why: string): never => {
    throw new Error(`places.json case ${String(at)}: ${why}`);
  };
  if (typeof value !== 'object' || value === null) {
    return fail('not an object');
  }
  const { heard, id, location, names, near, said, voice } = value as Record<string, unknown>;
  if (!isText(id) || !isText(location) || !isText(said) || !isText(voice)) {
    return fail('id, location, said and voice are texts');
  }
  if (!Array.isArray(heard) || heard.length === 0 || !heard.every(isSegment)) {
    return fail(`${id}: heard is a list of segments`);
  }
  if (!Array.isArray(names) || names.length === 0 || !names.every(isText)) {
    return fail(`${id}: names is a list of texts`);
  }
  if (!isText(near) || CITIES[near] === undefined) {
    return fail(`${id}: near is one of ${Object.keys(CITIES).join(', ')}`);
  }
  return { heard, id, location, names, near, said, voice };
};

export const loadPlaceCases = (path: string): ReadonlyArray<PlaceCase> => {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(parsed)) {
    throw new Error('places.json is a list of cases');
  }
  const cases = parsed.map(readCase);
  const ids = new Set<string>();
  for (const each of cases) {
    if (ids.has(each.id)) {
      throw new Error(`places.json: two cases are ${each.id}`);
    }
    ids.add(each.id);
  }
  return cases;
};

/** Whether the case's place is among the words heard: else no reading can be had of it. */
export const locationHeard = (each: PlaceCase): boolean =>
  findWords(
    wordsOf(each.location),
    each.heard.flatMap((segment) => wordsOf(segment.text)),
  ).length > 0;

/** A name as compared: folded, letters and digits only ("Loos Bar" and "Loosbar" alike). */
const nameKey = (name: string): string =>
  foldSearchText(name)
    .replaceAll('ß', 'ss')
    .replaceAll(/[^\p{L}\p{N}]/gu, '');

/** Whether a candidate is the place meant: its name begins with one of MapKit's names for it. */
export const isPlaceMeant = (candidate: PlaceCandidate, names: ReadonlyArray<string>): boolean => {
  const name = nameKey(candidate.geo.name ?? candidate.geo.source);
  return names.some((each) => name.startsWith(nameKey(each)));
};

/** How one lookup did: the place meant taken, offered at a place in the list, by which reading. */
export interface PlaceOutcome {
  /** What came back, as a choice lists it. */
  readonly candidates: ReadonlyArray<{
    readonly address?: string | undefined;
    readonly alternative?: string | undefined;
    readonly match: PlaceCandidate['match'];
    readonly name: string;
    readonly source: PlaceCandidate['source'];
  }>;
  /** MapKit calls that failed (throttled, offline) or gave no answer in time: a miss may be one of these. */
  readonly errors: ReadonlyArray<string>;
  /** The reading the place meant was found for, when it was another reading's. */
  readonly foundAs?: string | undefined;
  /** Its place among the candidates, from 1; none when it is not among them. */
  readonly offered?: number | undefined;
  /** It was taken unasked, as the draft would hold it. */
  readonly taken: boolean;
}

export const outcomeOf = (
  candidates: ReadonlyArray<PlaceCandidate>,
  names: ReadonlyArray<string>,
  errors: ReadonlyArray<string> = [],
): PlaceOutcome => {
  const at = candidates.findIndex((candidate) => isPlaceMeant(candidate, names));
  const meant = candidates[at];
  const taken = preselectedPlace(candidates);
  return {
    candidates: candidates.map((candidate) => ({
      ...(candidate.address ? { address: candidate.address } : {}),
      ...(candidate.alternative ? { alternative: candidate.alternative } : {}),
      match: candidate.match,
      name: candidate.geo.name ?? candidate.geo.source,
      source: candidate.source,
    })),
    errors,
    ...(meant?.alternative ? { foundAs: meant.alternative } : {}),
    ...(meant === undefined ? {} : { offered: at + 1 }),
    taken: taken !== undefined && isPlaceMeant(taken, names),
  };
};

/** One case's report: the readings asked, and each arm's outcome. */
export interface PlaceCaseReport {
  readonly alternatives: ReadonlyArray<string>;
  readonly asWritten: PlaceOutcome;
  readonly id: string;
  readonly location: string;
  readonly readings: PlaceOutcome;
  readonly said: string;
  readonly voice: string;
}

export interface PlaceReport {
  readonly cases: ReadonlyArray<PlaceCaseReport>;
  readonly sha: string;
  readonly when: string;
}

/** The arms' totals: taken and offered, and how many only a reading found. */
export const placeScore = (cases: ReadonlyArray<PlaceCaseReport>) => ({
  asWritten: {
    offered: cases.filter((each) => each.asWritten.offered !== undefined).length,
    taken: cases.filter((each) => each.asWritten.taken).length,
  },
  cases: cases.length,
  errors: cases.filter(
    (each) => each.asWritten.errors.length > 0 || each.readings.errors.length > 0,
  ).length,
  readings: {
    offered: cases.filter((each) => each.readings.offered !== undefined).length,
    onlyByReading: cases.filter(
      (each) => each.asWritten.offered === undefined && each.readings.foundAs !== undefined,
    ).length,
    taken: cases.filter((each) => each.readings.taken).length,
  },
});

const outcomeText = (outcome: PlaceOutcome): string =>
  outcome.taken
    ? 'taken'
    : outcome.offered === undefined
      ? '–'
      : `offered ${String(outcome.offered)}${outcome.foundAs ? ` as “${outcome.foundAs}”` : ''}`;

export const formatPlaceReport = (report: PlaceReport): string => {
  const score = placeScore(report.cases);
  const of = `/${String(score.cases)}`;
  const lines = [
    `   as written     taken ${String(score.asWritten.taken)}${of} · offered ${String(score.asWritten.offered)}${of}`,
    `   with readings  taken ${String(score.readings.taken)}${of} · offered ${String(score.readings.offered)}${of} · only by a reading ${String(score.readings.onlyByReading)}`,
    ...(score.errors > 0
      ? [
          `   ${String(score.errors)} case(s) with a MapKit call that failed or gave no answer in time: their misses may be that`,
        ]
      : []),
  ];
  for (const each of report.cases) {
    lines.push(
      `   ${each.id.padEnd(28)} “${each.location}” → ${outcomeText(each.asWritten)} | ${outcomeText(each.readings)}${
        each.alternatives.length > 0
          ? `  (${each.alternatives.join(', ')})`
          : '  (no other reading)'
      }`,
    );
  }
  return lines.join('\n');
};
