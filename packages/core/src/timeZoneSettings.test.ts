import { Schema } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  defaultTimeZoneSettings,
  secondaryZones,
  TimeZoneSettings,
  withPrimary,
  withZoneAdded,
  withZoneRemoved,
} from './timeZoneSettings.ts';

const decode = Schema.decodeUnknownOption(TimeZoneSettings);
const accepts = (value: unknown) => decode(value)._tag === 'Some';

describe('TimeZoneSettings schema', () => {
  it('accepts one to three unique known zones with a member primary', () => {
    expect(accepts(defaultTimeZoneSettings('Europe/Vienna'))).toBe(true);
    expect(
      accepts({ primary: 'Asia/Kolkata', zones: ['Europe/Vienna', 'Asia/Kolkata', 'UTC'] }),
    ).toBe(true);
  });

  it('rejects an empty list, four zones and duplicates', () => {
    expect(accepts({ primary: 'UTC', zones: [] })).toBe(false);
    expect(
      accepts({
        primary: 'UTC',
        zones: ['UTC', 'Europe/Vienna', 'Asia/Kolkata', 'Asia/Tokyo'],
      }),
    ).toBe(false);
    expect(accepts({ primary: 'UTC', zones: ['UTC', 'UTC'] })).toBe(false);
  });

  it('rejects a primary outside the list and an unknown zone', () => {
    expect(accepts({ primary: 'Asia/Tokyo', zones: ['UTC'] })).toBe(false);
    expect(accepts({ primary: 'Mars/Olympus', zones: ['Mars/Olympus'] })).toBe(false);
  });
});

describe('TimeZoneSettings editors', () => {
  const settings = { primary: 'Europe/Vienna', zones: ['Europe/Vienna', 'Asia/Kolkata'] };

  it('lists the secondary zones in order', () => {
    expect(secondaryZones(settings)).toEqual(['Asia/Kolkata']);
    expect(secondaryZones({ ...settings, primary: 'Asia/Kolkata' })).toEqual(['Europe/Vienna']);
  });

  it('adds up to the cap and ignores repeats', () => {
    expect(withZoneAdded(settings, 'Asia/Kolkata')).toBe(settings);
    const three = withZoneAdded(settings, 'UTC');
    expect(three.zones).toEqual(['Europe/Vienna', 'Asia/Kolkata', 'UTC']);
    expect(withZoneAdded(three, 'Asia/Tokyo')).toBe(three);
  });

  it('removes a zone, promoting the first remaining when the primary goes', () => {
    expect(withZoneRemoved(settings, 'Asia/Kolkata')).toEqual({
      primary: 'Europe/Vienna',
      zones: ['Europe/Vienna'],
    });
    expect(withZoneRemoved(settings, 'Europe/Vienna')).toEqual({
      primary: 'Asia/Kolkata',
      zones: ['Asia/Kolkata'],
    });
    expect(withZoneRemoved(settings, 'UTC')).toBe(settings);
  });

  it('never empties the list', () => {
    const single = defaultTimeZoneSettings('UTC');
    expect(withZoneRemoved(single, 'UTC')).toBe(single);
  });

  it('switches the primary only to a member', () => {
    expect(withPrimary(settings, 'Asia/Kolkata').primary).toBe('Asia/Kolkata');
    expect(withPrimary(settings, 'UTC')).toBe(settings);
  });
});
