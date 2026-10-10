import { describe, expect, it } from 'vite-plus/test';
import {
  allTimeZoneIds,
  canonicalZoneId,
  engineRecurrenceLines,
  engineZoneId,
  isValidTimeZone,
  runtimeZoneId,
  searchTimeZones,
  TIME_ZONE_IDS,
  zoneCity,
  zoneRegion,
  zoneSlug,
} from './zones.ts';

/** Hermes as it is: some current names rejected, some legacy ones too. */
const hermes = (id: string) =>
  id !== 'Asia/Kolkata' && id !== 'America/Buenos_Aires' && id !== 'Mars/Olympus';

// Under Hermes a series' EXDATE in Asia/Kolkata would throw.
const hermesSpell = (id: string) => runtimeZoneId(id, hermes) ?? id;

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

  it('reads a stored legacy spelling as its current name', () => {
    expect(canonicalZoneId('Asia/Calcutta')).toBe('Asia/Kolkata');
    expect(canonicalZoneId('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(zoneCity('Asia/Calcutta')).toBe('Kolkata');
    expect(zoneSlug('Asia/Calcutta')).toBe('Asia-Kolkata');
    expect(zoneRegion('America/Buenos_Aires')).toBe('America');
  });

  it('resolves each catalog id to the spelling the engine accepts', () => {
    // Node knows both spellings, so the catalog resolves to itself.
    expect(runtimeZoneId('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(allTimeZoneIds()).toEqual([...TIME_ZONE_IDS]);
    expect(runtimeZoneId('Asia/Kolkata', hermes)).toBe('Asia/Calcutta');
    expect(runtimeZoneId('Europe/Vienna', hermes)).toBe('Europe/Vienna');
    expect(runtimeZoneId('Mars/Olympus', hermes)).toBeUndefined();
  });

  it('spells an event zone the way the engine reads it', () => {
    // Node knows every spelling, so ids stand as they are.
    expect(engineZoneId('Asia/Kolkata')).toBe('Asia/Kolkata');
    expect(engineZoneId('Mars/Olympus')).toBe('Mars/Olympus');
    expect(
      engineRecurrenceLines(
        [
          'RRULE:FREQ=WEEKLY;BYDAY=MO',
          'EXDATE;TZID=Asia/Kolkata:20261005T093000,20261012T093000',
          'RDATE;TZID="Asia/Kolkata":20261020T093000',
          'EXDATE;TZID=America/Buenos_Aires:20261005T093000',
          'EXDATE;TZID=Europe/Vienna:20261005T093000',
        ],
        hermesSpell,
      ),
    ).toEqual([
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'EXDATE;TZID=Asia/Calcutta:20261005T093000,20261012T093000',
      'RDATE;TZID="Asia/Calcutta":20261020T093000',
      'EXDATE;TZID=America/Argentina/Buenos_Aires:20261005T093000',
      'EXDATE;TZID=Europe/Vienna:20261005T093000',
    ]);
  });

  it('resolves a legacy id Google stored to the current name the engine takes', () => {
    // A calendar's zone can arrive legacy: falling back to the device zone
    // moved an all-day reminder's midnight by hours.
    expect(runtimeZoneId('America/Buenos_Aires', hermes)).toBe('America/Argentina/Buenos_Aires');
    expect(runtimeZoneId('Asia/Calcutta', hermes)).toBe('Asia/Calcutta');
    // Neither spelling known: nothing to offer.
    expect(
      runtimeZoneId(
        'America/Buenos_Aires',
        (id) => id !== 'America/Buenos_Aires' && id !== 'America/Argentina/Buenos_Aires',
      ),
    ).toBeUndefined();
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

  it('lists the whole catalog for an empty query, in catalog order', () => {
    const all = searchTimeZones('');
    expect(all.map((match) => match.id)).toEqual(allTimeZoneIds());
    expect(searchTimeZones('   ')).toEqual(all);
    expect(searchTimeZones('', ['UTC'])).toHaveLength(all.length - 1);
  });

  it('drops excluded zones', () => {
    expect(searchTimeZones('kolk', ['Asia/Kolkata'])).toEqual([]);
  });

  it('searches a legacy-spelled catalog by the current city name', () => {
    const match = searchTimeZones('kolk', [], ['Asia/Calcutta', 'Europe/Vienna']);
    expect(match).toEqual([{ city: 'Kolkata', id: 'Asia/Calcutta', region: 'Asia' }]);
  });

  it('returns nothing for a query matching no zone', () => {
    expect(searchTimeZones('zzzz')).toEqual([]);
  });
});
