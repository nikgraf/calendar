import { Schema } from 'effect';
import { describe, expect, it } from 'vite-plus/test';
import {
  DEFAULT_TIME_ZONE_SETTINGS,
  DEVICE_ZONE,
  resolveTimeZones,
  TimeZoneSettings,
  withDeviceEntry,
  withPrimary,
  withZoneAdded,
  withZoneRemoved,
} from './timeZoneSettings.ts';

const decode = Schema.decodeUnknownOption(TimeZoneSettings);
const accepts = (value: unknown) => decode(value)._tag === 'Some';

describe('TimeZoneSettings schema', () => {
  it('accepts one to three unique entries with the device entry and a member primary', () => {
    expect(accepts(DEFAULT_TIME_ZONE_SETTINGS)).toBe(true);
    expect(accepts({ primary: 'Asia/Kolkata', zones: ['device', 'Asia/Kolkata', 'UTC'] })).toBe(
      true,
    );
    expect(accepts({ primary: 'device', zones: ['Europe/Vienna', 'device'] })).toBe(true);
  });

  it('rejects an empty list, four entries and duplicates', () => {
    expect(accepts({ primary: 'device', zones: [] })).toBe(false);
    expect(
      accepts({
        primary: 'UTC',
        zones: ['device', 'UTC', 'Europe/Vienna', 'Asia/Kolkata'],
      }),
    ).toBe(false);
    expect(accepts({ primary: 'UTC', zones: ['device', 'UTC', 'UTC'] })).toBe(false);
  });

  it('rejects a list without the device entry, a primary outside the list and an unknown zone', () => {
    expect(accepts({ primary: 'UTC', zones: ['UTC'] })).toBe(false);
    expect(accepts({ primary: 'Asia/Tokyo', zones: ['device', 'UTC'] })).toBe(false);
    expect(accepts({ primary: 'device', zones: ['device', 'Mars/Olympus'] })).toBe(false);
  });
});

describe('resolveTimeZones', () => {
  it('reads the device entry as the device zone, wherever it sits', () => {
    expect(resolveTimeZones(DEFAULT_TIME_ZONE_SETTINGS, 'Europe/Vienna')).toEqual({
      primary: 'Europe/Vienna',
      secondary: [],
    });
    expect(
      resolveTimeZones(
        { primary: 'Asia/Kolkata', zones: ['device', 'Asia/Kolkata', 'UTC'] },
        'Europe/Vienna',
      ),
    ).toEqual({ primary: 'Asia/Kolkata', secondary: ['Europe/Vienna', 'UTC'] });
    expect(
      resolveTimeZones(
        { primary: 'device', zones: ['device', 'Asia/Kolkata'] },
        'America/New_York',
      ),
    ).toEqual({ primary: 'America/New_York', secondary: ['Asia/Kolkata'] });
  });

  it('shows a fixed zone the device is in right now only once', () => {
    const home = { primary: 'Europe/Vienna', zones: ['device', 'Europe/Vienna', 'UTC'] };
    expect(resolveTimeZones(home, 'Europe/Vienna').secondary).toEqual(['UTC']);
    expect(resolveTimeZones(home, 'Asia/Tokyo').secondary).toEqual(['Asia/Tokyo', 'UTC']);
    // The device spells its zone the legacy way (Hermes): still the same zone.
    expect(
      resolveTimeZones({ primary: 'device', zones: ['device', 'Asia/Kolkata'] }, 'Asia/Calcutta'),
    ).toEqual({ primary: 'Asia/Calcutta', secondary: [] });
    // A host that reports UTC by one of its links.
    expect(
      resolveTimeZones({ primary: 'device', zones: ['device', 'UTC'] }, 'Etc/UTC').secondary,
    ).toEqual([]);
  });
});

describe('withDeviceEntry', () => {
  it('swaps the entry that is the device zone, keeping its place and primary status', () => {
    expect(
      withDeviceEntry(
        { primary: 'Europe/Vienna', zones: ['Asia/Kolkata', 'Europe/Vienna'] },
        'Europe/Vienna',
      ),
    ).toEqual({ primary: 'device', zones: ['Asia/Kolkata', 'device'] });
    expect(
      withDeviceEntry(
        { primary: 'Asia/Kolkata', zones: ['Europe/Vienna', 'Asia/Kolkata'] },
        'Europe/Vienna',
      ),
    ).toEqual({ primary: 'Asia/Kolkata', zones: ['device', 'Asia/Kolkata'] });
    expect(
      withDeviceEntry({ primary: 'Asia/Kolkata', zones: ['Asia/Kolkata'] }, 'Asia/Calcutta'),
    ).toEqual({
      primary: 'device',
      zones: ['device'],
    });
    expect(withDeviceEntry({ primary: 'UTC', zones: ['UTC', 'Asia/Kolkata'] }, 'Etc/UTC')).toEqual({
      primary: 'device',
      zones: ['device', 'Asia/Kolkata'],
    });
  });

  it('puts the device entry first when no entry is the device zone, trimming from the end but never the primary', () => {
    expect(
      withDeviceEntry({ primary: 'UTC', zones: ['UTC', 'Asia/Kolkata'] }, 'Europe/Vienna'),
    ).toEqual({
      primary: 'UTC',
      zones: ['device', 'UTC', 'Asia/Kolkata'],
    });
    expect(
      withDeviceEntry(
        { primary: 'Asia/Tokyo', zones: ['UTC', 'Asia/Kolkata', 'Asia/Tokyo'] },
        'Europe/Vienna',
      ),
    ).toEqual({ primary: 'Asia/Tokyo', zones: ['device', 'UTC', 'Asia/Tokyo'] });
  });

  it('leaves a list that has the entry alone', () => {
    const settings = { primary: 'device', zones: ['device', 'UTC'] };
    expect(withDeviceEntry(settings, 'Europe/Vienna')).toBe(settings);
  });
});

describe('TimeZoneSettings editors', () => {
  const settings = { primary: DEVICE_ZONE, zones: [DEVICE_ZONE, 'Asia/Kolkata'] };

  it('adds up to the cap and ignores repeats', () => {
    expect(withZoneAdded(settings, 'Asia/Kolkata')).toBe(settings);
    expect(withZoneAdded(settings, DEVICE_ZONE)).toBe(settings);
    const three = withZoneAdded(settings, 'UTC');
    expect(three.zones).toEqual(['device', 'Asia/Kolkata', 'UTC']);
    expect(withZoneAdded(three, 'Asia/Tokyo')).toBe(three);
  });

  it('removes a zone, promoting the device entry when the primary goes', () => {
    expect(withZoneRemoved(settings, 'Asia/Kolkata')).toEqual(DEFAULT_TIME_ZONE_SETTINGS);
    expect(withZoneRemoved({ ...settings, primary: 'Asia/Kolkata' }, 'Asia/Kolkata')).toEqual(
      DEFAULT_TIME_ZONE_SETTINGS,
    );
    expect(withZoneRemoved(settings, 'UTC')).toBe(settings);
  });

  it('never removes the device entry', () => {
    expect(withZoneRemoved(settings, DEVICE_ZONE)).toBe(settings);
    expect(withZoneRemoved(DEFAULT_TIME_ZONE_SETTINGS, DEVICE_ZONE)).toBe(
      DEFAULT_TIME_ZONE_SETTINGS,
    );
  });

  it('switches the primary only to a member', () => {
    expect(withPrimary(settings, 'Asia/Kolkata').primary).toBe('Asia/Kolkata');
    expect(withPrimary({ ...settings, primary: 'Asia/Kolkata' }, DEVICE_ZONE).primary).toBe(
      'device',
    );
    expect(withPrimary(settings, 'UTC')).toBe(settings);
  });
});
