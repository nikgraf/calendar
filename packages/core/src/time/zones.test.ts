import { describe, expect, it } from 'vitest';
import {
  isValidTimeZone,
  searchTimeZones,
  TIME_ZONE_IDS,
  zoneCity,
  zoneRegion,
  zoneSlug,
} from './zones.ts';

describe('zones catalog', () => {
  it('holds only ids Temporal knows, without duplicates, sorted', () => {
    const unknown = TIME_ZONE_IDS.filter((id) => !isValidTimeZone(id));
    expect(unknown).toEqual([]);
    expect(new Set(TIME_ZONE_IDS).size).toBe(TIME_ZONE_IDS.length);
    expect([...TIME_ZONE_IDS].sort()).toEqual([...TIME_ZONE_IDS]);
    expect(TIME_ZONE_IDS).toContain('UTC');
    expect(TIME_ZONE_IDS.some((id) => id.startsWith('Etc/'))).toBe(false);
  });

  it('rejects an unknown zone', () => {
    expect(isValidTimeZone('Mars/Olympus')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
  });

  it('derives city, region and slug from the id', () => {
    expect(zoneCity('America/Los_Angeles')).toBe('Los Angeles');
    expect(zoneCity('America/Argentina/Buenos_Aires')).toBe('Buenos Aires');
    expect(zoneCity('UTC')).toBe('UTC');
    expect(zoneRegion('America/Argentina/Buenos_Aires')).toBe('America');
    expect(zoneRegion('UTC')).toBe('');
    expect(zoneSlug('Asia/Kolkata')).toBe('Asia-Kolkata');
  });
});

describe('searchTimeZones', () => {
  it('ranks city prefixes first', () => {
    expect(searchTimeZones('kolk')[0]?.id).toBe('Asia/Kolkata');
    expect(searchTimeZones('los ang')[0]?.id).toBe('America/Los_Angeles');
    expect(searchTimeZones('Angeles')[0]?.id).toBe('America/Los_Angeles');
  });

  it('matches by region and by raw id', () => {
    const europe = searchTimeZones('europe');
    expect(europe.length).toBeGreaterThan(10);
    expect(europe.every((match) => match.region === 'Europe')).toBe(true);
    expect(searchTimeZones('asia/kol')[0]?.id).toBe('Asia/Kolkata');
  });

  it('lists everything for an empty query, capped', () => {
    expect(searchTimeZones('').length).toBe(50);
    expect(searchTimeZones('   ').length).toBe(50);
  });

  it('drops excluded zones', () => {
    expect(searchTimeZones('kolk', ['Asia/Kolkata'])).toEqual([]);
  });

  it('returns nothing for a query matching no zone', () => {
    expect(searchTimeZones('zzzz')).toEqual([]);
  });
});
