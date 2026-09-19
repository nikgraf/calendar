import type { PlaceSuggestion } from '@calendar/core';
import { Effect } from 'effect';
import type { GeoClientShape } from './client.ts';
import type { GeoPlaceJson } from './protocol.ts';

/** One place the fake knows: a typeahead row plus its coordinates. */
export interface FakePlace {
  readonly address?: string | undefined;
  readonly lat: number;
  readonly lng: number;
  readonly name?: string | undefined;
  readonly subtitle?: string | undefined;
  readonly title: string;
}

export interface FakeGeoState {
  /** Method log ('search:<query>', 'resolve:<query>', 'snapshot'). */
  readonly calls: Array<string>;
  places: Array<FakePlace>;
}

/** A valid 1×1 transparent PNG: deterministic stand-in for a map image. */
export const FAKE_MAP_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

const lower = (text: string | undefined): string => text?.toLowerCase() ?? '';

const toPlace = (place: FakePlace): GeoPlaceJson => ({
  address: place.address ?? place.subtitle,
  lat: place.lat,
  lng: place.lng,
  name: place.name ?? place.title,
});

/**
 * In-memory GeoClient for tests and the e2e fixture: deterministic,
 * offline. `search` is a case-insensitive substring match on title or
 * subtitle; `resolve` matches the picked suggestion exactly, else the
 * first place whose title appears in the query.
 */
export const makeFakeGeoClient = (
  initial: { readonly places?: ReadonlyArray<FakePlace> } = {},
): { readonly client: GeoClientShape; readonly state: FakeGeoState } => {
  const state: FakeGeoState = { calls: [], places: [...(initial.places ?? [])] };

  const client: GeoClientShape = {
    resolve: ({ query, suggestion }) =>
      Effect.sync(() => {
        state.calls.push(`resolve:${query}`);
        const exact = suggestion
          ? state.places.find(
              (place) => place.title === suggestion.title && place.subtitle === suggestion.subtitle,
            )
          : undefined;
        const match =
          exact ?? state.places.find((place) => lower(query).includes(lower(place.title)));
        return match ? toPlace(match) : null;
      }),
    search: ({ limit, query }) =>
      Effect.sync(() => {
        state.calls.push(`search:${query}`);
        const needle = lower(query.trim());
        const rows: Array<PlaceSuggestion> = state.places
          .filter(
            (place) =>
              lower(place.title).includes(needle) || lower(place.subtitle).includes(needle),
          )
          .map((place) =>
            place.subtitle === undefined
              ? { title: place.title }
              : { subtitle: place.subtitle, title: place.title },
          );
        return rows.slice(0, limit ?? 6);
      }),
    snapshot: () =>
      Effect.sync(() => {
        state.calls.push('snapshot');
        return FAKE_MAP_PNG_BASE64;
      }),
  };

  return { client, state };
};
