import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { makeGeoClient, unavailableGeoClient } from './client.ts';
import { FAKE_MAP_PNG_BASE64, makeFakeGeoClient } from './fake.ts';

describe('makeGeoClient', () => {
  it('sends the protocol method and params, and decodes the result', async () => {
    const calls: Array<[string, unknown]> = [];
    const client = makeGeoClient((method, params) => {
      calls.push([method, params]);
      return Promise.resolve(
        method === 'geo.search'
          ? { results: [{ subtitle: 'Wien', title: 'Naschmarkt' }] }
          : { place: { lat: 48.2, lng: 16.36, name: 'Naschmarkt' } },
      );
    });
    expect(await Effect.runPromise(client.search({ limit: 3, query: 'nasch' }))).toEqual([
      { subtitle: 'Wien', title: 'Naschmarkt' },
    ]);
    expect(
      await Effect.runPromise(
        client.resolve({
          query: 'Naschmarkt, Wien',
          suggestion: { subtitle: 'Wien', title: 'Naschmarkt' },
        }),
      ),
    ).toEqual({ lat: 48.2, lng: 16.36, name: 'Naschmarkt' });
    expect(calls).toEqual([
      ['geo.search', { limit: 3, query: 'nasch' }],
      [
        'geo.resolve',
        { query: 'Naschmarkt, Wien', suggestion: { subtitle: 'Wien', title: 'Naschmarkt' } },
      ],
    ]);
  });

  it('maps a missing helper to GeoUnavailableError and other failures to GeoRequestError', async () => {
    const unavailable = makeGeoClient(() => Promise.reject(new Error('helper unavailable: off')));
    const failing = makeGeoClient(() =>
      Promise.reject(new Error('X → Caused by: GeoBridgeError: failed: MKError 4')),
    );
    const first = await Effect.runPromise(Effect.result(unavailable.search({ query: 'x' })));
    const second = await Effect.runPromise(Effect.result(failing.resolve({ query: 'x' })));
    expect(first._tag === 'Failure' && first.failure._tag).toBe('GeoUnavailableError');
    expect(second._tag === 'Failure' && second.failure).toMatchObject({
      _tag: 'GeoRequestError',
      message: 'failed: MKError 4',
      method: 'geo.resolve',
    });
  });

  it('rejects a response that drifted from the protocol', async () => {
    const client = makeGeoClient(() => Promise.resolve({ place: { lat: 'north' } }));
    const result = await Effect.runPromise(Effect.result(client.resolve({ query: 'x' })));
    expect(result._tag === 'Failure' && result.failure._tag).toBe('GeoRequestError');
  });

  it('fails every method when unavailable', async () => {
    const client = unavailableGeoClient('no helper');
    const result = await Effect.runPromise(
      Effect.result(
        client.snapshot({ appearance: 'light', height: 1, lat: 0, lng: 0, scale: 1, width: 1 }),
      ),
    );
    expect(result._tag === 'Failure' && result.failure._tag).toBe('GeoUnavailableError');
  });
});

describe('makeFakeGeoClient', () => {
  const { client, state } = makeFakeGeoClient({
    places: [
      {
        lat: 37.78,
        lng: -122.4,
        subtitle: '66 Mint St, San Francisco',
        title: 'Blue Bottle Coffee',
      },
      { lat: 48.2, lng: 16.36, title: 'Naschmarkt' },
    ],
  });

  it('searches, resolves and snapshots deterministically', async () => {
    expect(await Effect.runPromise(client.search({ query: 'MINT' }))).toEqual([
      { subtitle: '66 Mint St, San Francisco', title: 'Blue Bottle Coffee' },
    ]);
    expect(await Effect.runPromise(client.resolve({ query: 'lunch at naschmarkt' }))).toMatchObject(
      { lat: 48.2, name: 'Naschmarkt' },
    );
    expect(await Effect.runPromise(client.resolve({ query: 'Atlantis' }))).toBeNull();
    expect(
      await Effect.runPromise(
        client.snapshot({ appearance: 'light', height: 1, lat: 0, lng: 0, scale: 1, width: 1 }),
      ),
    ).toBe(FAKE_MAP_PNG_BASE64);
    expect(state.calls).toEqual([
      'search:MINT',
      'resolve:lunch at naschmarkt',
      'resolve:Atlantis',
      'snapshot',
    ]);
  });
});
