import { Schema } from 'effect';
import { GeoLocation } from '../types.ts';
import { normalizeLocationKey, type PlaceSuggestion } from './location.ts';
import { distanceMeters, type GeoPoint, type GeoRegion, isDayTrip, isNearby } from './regions.ts';
import {
  calledExactly,
  namedPastLead,
  type PlaceLike,
  type PlaceMatch,
  placeMatch,
  sameAddress,
  saysOnlyKind,
  saysWhere,
} from './resemblance.ts';

/**
 * The places a phrase's location text could mean, for a choice: the
 * user's own past places first — a place they have been to beats any
 * search hit, and a dictated "Cafe Zentral" is found among them by how
 * it sounds, where MapKit's search is not — then MapKit's matches.
 */

export const PlaceCandidate = Schema.Struct({
  /** MapKit's address, when it has one; a past place has only its text. */
  address: Schema.optional(Schema.String),
  /** The coordinates; `source` is the text the location field takes on a pick. */
  geo: GeoLocation,
  /**
   * How it resembles the text; `search`: a hit that does not, or one far
   * from the user's places that the text does not say is there — offered
   * but never taken unasked.
   */
  match: Schema.Literals(['exact', 'phonetic', 'search', 'words']),
  /** `history`: a place of the user's own past events; `mapkit`: a search match. */
  source: Schema.Literals(['history', 'mapkit']),
});
export type PlaceCandidate = typeof PlaceCandidate.Type;

/** A place a past event was at, with the text it was written as. */
export interface PastPlace {
  readonly geo: GeoLocation;
  readonly lastUsedUtc: number;
}

/** Candidates offered at most. */
export const PLACE_CANDIDATE_LIMIT = 5;

const RANK: Record<PlaceMatch, number> = { exact: 0, phonetic: 2, words: 1 };
/** A name read past the lead it was written with: after every reading of the whole text. */
const PAST_LEAD_RANK = 2.5;

/** The better of two matches, if any. */
const best = (a: PlaceMatch | undefined, b: PlaceMatch | undefined): PlaceMatch | undefined =>
  a === undefined ? b : b === undefined ? a : RANK[a] <= RANK[b] ? a : b;

/**
 * How a past place resembles the text: by the text it was written as
 * (what the user said last time — an exact "Figlmüller"), or by MapKit's
 * name for it beside that text. A picked place is written "name,
 * address": the name is what it is, the address where (`placeMatch`), so
 * "Vienna, Austria" names no past place that merely stands there. A text
 * that does not begin with MapKit's name (an address typed or kept as
 * said) is all address beside that name.
 */
export const pastPlaceMatch = (text: string, geo: GeoLocation): PlaceMatch | undefined => {
  if (placeMatch(text, { name: geo.source }) === 'exact') {
    return 'exact';
  }
  const [written = '', ...rest] = geo.source.split(',');
  const address = rest.join(',');
  const named = geo.name !== undefined && placeMatch(written, { name: geo.name }) === 'exact';
  return best(
    placeMatch(text, { address, name: written }),
    geo.name === undefined
      ? undefined
      : placeMatch(text, { address: named ? address : geo.source, name: geo.name }),
  );
};

/**
 * The past places the text names, best first — exact, then by words,
 * then by sound — the most recently used first among equals. One per
 * place text (the latest use of it).
 */
export const rankPastPlaces = (
  text: string,
  places: ReadonlyArray<PastPlace>,
): ReadonlyArray<PlaceCandidate> => {
  const latest = new Map<string, PastPlace>();
  for (const place of places) {
    const key = normalizeLocationKey(place.geo.source);
    const known = latest.get(key);
    if (known === undefined || place.lastUsedUtc > known.lastUsedUtc) {
      latest.set(key, place);
    }
  }
  const ranked = [...latest.values()]
    .flatMap((place) => {
      const match = pastPlaceMatch(text, place.geo);
      return match === undefined ? [] : [{ match, place }];
    })
    .sort((a, b) => RANK[a.match] - RANK[b.match] || b.place.lastUsedUtc - a.place.lastUsedUtc)
    .map(({ match, place }) => ({ geo: place.geo, match, source: 'history' as const }));
  // One place written two ways is one place: the better-ranked text stays.
  const once: Array<PlaceCandidate> = [];
  for (const candidate of ranked) {
    if (!listed(candidate.geo, once)) {
      once.push(candidate);
    }
  }
  return once;
};

/** Nearer than this, a hit of the same name is a place already listed over again. */
const SAME_PLACE_METERS = 100;

/** A place's name as its own: MapKit's, else the text it was written as. */
const nameOf = (place: GeoLocation): string => normalizeLocationKey(place.name ?? place.source);

/**
 * Whether the place is one already listed: the same text, or the same
 * name within a hundred meters (a branch around the corner with a name
 * of its own is another place).
 */
const listed = (place: GeoLocation, among: ReadonlyArray<PlaceCandidate>): boolean =>
  among.some(
    (candidate) =>
      normalizeLocationKey(candidate.geo.source) === normalizeLocationKey(place.source) ||
      (nameOf(candidate.geo) === nameOf(place) &&
        distanceMeters(candidate.geo, place) <= SAME_PLACE_METERS),
  );

/**
 * History first, then the search's hits in their order, each once (two
 * searches answer the same place; the same text, or within a hundred
 * meters, is one place), at most `limit` in all.
 */
export const mergePlaceCandidates = (
  history: ReadonlyArray<PlaceCandidate>,
  found: ReadonlyArray<PlaceCandidate>,
  limit: number = PLACE_CANDIDATE_LIMIT,
): ReadonlyArray<PlaceCandidate> => {
  const merged: Array<PlaceCandidate> = [...history];
  for (const candidate of found) {
    if (!listed(candidate.geo, merged)) {
      merged.push(candidate);
    }
  }
  return merged.slice(0, limit);
};

/**
 * Whether a search hit is one the text names, where it is aside: it
 * resembles the whole text (`placeMatch`) — a text that says only a
 * kind of place by its exact name alone (`saysOnlyKind`) — or is the
 * venue called what follows the text's lead (`namedPastLead`).
 */
export const namesFound = (text: string, place: PlaceLike): boolean => {
  const match = placeMatch(text, place);
  return saysOnlyKind(text) ? match === 'exact' : match !== undefined || namedPastLead(text, place);
};

/** A place a search found: where it is and what MapKit calls it. */
export interface FoundPlace extends GeoPoint, PlaceLike {}

/** Far namesakes offered at most: the search's best one, for a trip the text does not name. */
const FAR_OFFERS = 1;

/**
 * What a search found for a text, each place with how far it may be
 * trusted, the ones to trust first. A hit is the place the text names
 * when it resembles the words (`placeMatch`) and is nearby (`isNearby`)
 * or the text says where it is (`saysWhere`): a search answers with a
 * namesake on another continent as readily as with nothing — "Cafe Meek"
 * found Meek Café in Benoni, 8,000 km from every event the user has. The
 * rest is `search`, offered and never taken: the nearby hits that do not
 * resemble the text, then one far namesake. Any other far hit is no
 * one's guess and is left out. A text that says only a kind of place
 * ("home", "the office": `saysOnlyKind`) names one only by its exact
 * name, whatever else resembles it. A text no hit resembles whole may
 * be a venue written with its lead ("im Figlmüller": `namedPastLead`):
 * it is named when nearby, after the hits the whole text names. Only a
 * search hit: a past place is written by hand, often without the
 * address that tells a town from a venue, and comes before every hit.
 */
export const rankFoundPlaces = <Place extends FoundPlace>(
  text: string,
  places: ReadonlyArray<Place>,
  region: GeoRegion | undefined,
): ReadonlyArray<{ readonly match: PlaceCandidate['match']; readonly place: Place }> => {
  const kindOnly = saysOnlyKind(text);
  const read = places.map((place, index) => {
    const match = placeMatch(text, place);
    const near = isNearby(region, place);
    const whole =
      match !== undefined && (!kindOnly || match === 'exact') && (near || saysWhere(text, place))
        ? match
        : undefined;
    const pastLead = whole === undefined && !kindOnly && near && namedPastLead(text, place);
    const named: PlaceMatch | undefined = whole ?? (pastLead ? 'words' : undefined);
    // Named first, by how well, a name read past its lead last among
    // them; then the nearby rest; then far namesakes.
    const order =
      whole !== undefined
        ? RANK[whole]
        : pastLead
          ? PAST_LEAD_RANK
          : near
            ? 3
            : match !== undefined || namesFound(text, place)
              ? 4
              : 5;
    return { index, named, order, place };
  });
  const offered = read.filter((entry) => entry.order === 4).slice(0, FAR_OFFERS);
  return read
    .filter((entry) => entry.order < 4 || offered.includes(entry))
    .sort((a, b) => a.order - b.order || a.index - b.index)
    .map(({ named, place }) => ({ match: named ?? ('search' as const), place }));
};

/**
 * Whether a search hit proves that a name is a place, where the words
 * around it did not say so ("… im Figlmüller", "at Luigi's"): a venue
 * called exactly that (`calledExactly`: no name that only holds the
 * words or sounds like them, no town, no street) within a day trip of
 * the user's places (`isDayTrip`). Everything a search answers a common
 * word with fails one of the three: "Regen" a town, "Anna" a street
 * ("Annagasse"), "Pause" a café called "die Pause", "Bett" a club 600 km
 * away.
 */
export const provesName = (
  name: string,
  place: FoundPlace,
  region: GeoRegion | undefined,
): boolean => calledExactly(name, place) && isDayTrip(region, place);

/** A search hit as a candidate: the text a pick writes is its name and address, as a picked typeahead row's. */
const foundCandidate = (
  text: string,
  { match, place }: { readonly match: PlaceCandidate['match']; readonly place: FoundPlace },
): PlaceCandidate => {
  const name = place.name ?? text;
  return {
    ...(place.address ? { address: place.address } : {}),
    geo: new GeoLocation({
      lat: place.lat,
      lng: place.lng,
      name: place.name,
      source: place.address ? `${name}, ${place.address}` : name,
    }),
    match,
    source: 'mapkit',
  };
};

/**
 * The candidates for a text, from the user's past places and what a
 * search found: the past places first (`rankPastPlaces`), then the hits
 * as far as each may be trusted (`rankFoundPlaces`), each place once.
 *
 * `possible`: the text is a name a first phrase ends in that no word
 * calls a place — "im Figlmüller" and "im Regen", "at Luigi's" and "at
 * Thanksgiving" are written alike. Such a name gets candidates only with
 * proof that it is a place: a past place written exactly that, else a
 * search hit that proves it (`provesName`). The proof comes first, so it
 * is the one taken (`preselectedPlace`); without one there is nothing,
 * and the draft keeps the words in its title.
 */
export const placeCandidatesFor = (
  text: string,
  {
    found,
    past,
    possible = false,
    region,
  }: {
    readonly found: ReadonlyArray<FoundPlace>;
    readonly past: ReadonlyArray<PastPlace>;
    readonly possible?: boolean | undefined;
    readonly region: GeoRegion | undefined;
  },
): ReadonlyArray<PlaceCandidate> => {
  const history = rankPastPlaces(text, past);
  const ranked = rankFoundPlaces(text, found, region);
  const hits = ranked.map((hit) => foundCandidate(text, hit));
  if (!possible) {
    return mergePlaceCandidates(history, hits);
  }
  const proof =
    history.find(({ match }) => match === 'exact') ??
    hits.find(
      (_, at) => ranked[at]!.match === 'exact' && provesName(text, ranked[at]!.place, region),
    );
  return proof === undefined ? [] : mergePlaceCandidates([proof], [...history, ...hits]);
};

/**
 * The candidate a turn takes without asking: the best one, when it
 * resembles the text at all — a past place, or a search match by name,
 * words or sound that is nearby or where the text says. A hit that is
 * neither is offered, never taken: the text stays as said.
 */
export const preselectedPlace = (
  candidates: ReadonlyArray<PlaceCandidate>,
): PlaceCandidate | undefined => {
  const [first] = candidates;
  return first !== undefined && first.match !== 'search' ? first : undefined;
};

/** A candidate as a chip names it: a past place by its text, a search hit by its name and address. */
export const placeCandidateLabel = (candidate: PlaceCandidate): string => {
  if (candidate.source === 'history') {
    return candidate.geo.source;
  }
  const name = candidate.geo.name ?? candidate.geo.source;
  return candidate.address ? `${name} · ${candidate.address}` : name;
};

/** Whether two typeahead rows are one place: the same name at the same address. */
const sameRow = (a: PlaceSuggestion, b: PlaceSuggestion): boolean =>
  placeMatch(a.title, { name: b.title }) === 'exact' && sameAddress(a.subtitle, b.subtitle);

/**
 * The typeahead's rows once the search has filled in. The completer
 * reads only how a name begins: a letter off ("kaffeemik" for Kaffemik)
 * and it answers with a namesake in another country or nothing, where the
 * search reads the misspelling. The places the search found that the
 * text names (`rankFoundPlaces`: resembling it, and nearby or where it
 * says) come first, unless the completer lists them too: those take the
 * completer's row's place, coordinates and all. At most `limit` rows.
 */
export const withFoundSuggestions = (
  rows: ReadonlyArray<PlaceSuggestion>,
  found: ReadonlyArray<{ readonly match: PlaceCandidate['match']; readonly place: FoundPlace }>,
  limit: number,
): ReadonlyArray<PlaceSuggestion> => {
  const named: Array<PlaceSuggestion> = [];
  for (const { match, place } of found) {
    const title = place.name?.trim() ?? '';
    const row: PlaceSuggestion = {
      coordinates: { lat: place.lat, lng: place.lng },
      ...(place.address ? { subtitle: place.address } : {}),
      title,
    };
    if (match !== 'search' && title !== '' && !named.some((listed) => sameRow(listed, row))) {
      named.push(row);
    }
  }
  const completed = rows.map((row) => named.find((listed) => sameRow(listed, row)) ?? row);
  const fresh = named.filter((listed) => !rows.some((row) => sameRow(listed, row)));
  // One place once, however many rows the completer gave it.
  const once: Array<PlaceSuggestion> = [];
  for (const row of [...fresh, ...completed]) {
    if (!once.some((listed) => sameRow(listed, row))) {
      once.push(row);
    }
  }
  return once.slice(0, limit);
};
