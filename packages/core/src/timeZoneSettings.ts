import { Schema } from 'effect';
import { canonicalZoneId, isValidTimeZone, MAX_TIME_ZONES } from './time/zones.ts';

/**
 * The entry that stands for this device's own zone, whatever the OS says
 * it is right now. Stored as this word, never as the IANA id it resolves
 * to, so the grid follows the device after a flight and a settings file
 * written on one device reads correctly on another. Every list holds it
 * (it is never removed), first by construction; it can be the primary.
 */
export const DEVICE_ZONE = 'device';

export const isDeviceZone = (zone: string): boolean => zone === DEVICE_ZONE;

/**
 * Device-local: the zones this device draws, one of them primary. The
 * primary zone replaces the device zone for everything the UI draws (hour
 * axis, event placement, "today", editors); the others annotate the gutter,
 * event blocks and the editor. An entry is `DEVICE_ZONE` or an IANA id.
 * Stored in device_settings, never synced.
 */
export const TimeZoneSettings = Schema.Struct({
  /** The zone the grid, editors and "today" use; one of `zones`. */
  primary: Schema.String,
  /** 1..MAX_TIME_ZONES unique entries, the device entry among them, in the order the gutter shows them. */
  zones: Schema.Array(Schema.String).pipe(
    Schema.check(Schema.isBetweenLength(1, MAX_TIME_ZONES), Schema.isUnique()),
  ),
}).pipe(
  Schema.check(
    Schema.makeFilter((settings) =>
      settings.zones.includes(settings.primary)
        ? undefined
        : { issue: 'primary must be one of zones', path: ['primary'] },
    ),
    Schema.makeFilter((settings) =>
      settings.zones.includes(DEVICE_ZONE)
        ? undefined
        : { issue: `zones must include the device entry "${DEVICE_ZONE}"`, path: ['zones'] },
    ),
    Schema.makeFilter((settings) => {
      const unknown = settings.zones.find((zone) => !isDeviceZone(zone) && !isValidTimeZone(zone));
      return unknown === undefined
        ? undefined
        : { issue: `unknown time zone ${unknown}`, path: ['zones'] };
    }),
  ),
);
export type TimeZoneSettings = typeof TimeZoneSettings.Type;

/** Nothing stored: the device's own zone, and only that. */
export const DEFAULT_TIME_ZONE_SETTINGS: TimeZoneSettings = {
  primary: DEVICE_ZONE,
  zones: [DEVICE_ZONE],
};

export interface ResolvedTimeZones {
  /** The IANA zone the grid, "today" and the editors use. */
  readonly primary: string;
  /** The other IANA zones, in settings order, none of them the primary's. */
  readonly secondary: ReadonlyArray<string>;
}

/**
 * Entries → IANA ids, the device entry as `deviceZone`. A fixed zone that
 * is the device's right now (home, pinned before a trip) is left out of
 * the secondaries, compared by canonical name since the device may spell
 * its zone the legacy way: the gutter never shows one hour twice.
 */
export const resolveTimeZones = (
  settings: TimeZoneSettings,
  deviceZone: string,
): ResolvedTimeZones => {
  const resolve = (zone: string): string => (isDeviceZone(zone) ? deviceZone : zone);
  const primary = resolve(settings.primary);
  const seen = new Set([canonicalZoneId(primary)]);
  const secondary: Array<string> = [];
  for (const zone of settings.zones) {
    if (zone === settings.primary) {
      continue;
    }
    const id = resolve(zone);
    const key = canonicalZoneId(id);
    if (!seen.has(key)) {
      seen.add(key);
      secondary.push(id);
    }
  }
  return { primary, secondary };
};

/**
 * A list from before the device entry existed, with one. The entry that is
 * `deviceZone` becomes the device entry, keeping its place and primary
 * status; with none, the device entry goes first and the list is trimmed
 * to the cap from the end, never dropping the primary. A list that already
 * has the entry is returned as is.
 */
export const withDeviceEntry = (
  settings: TimeZoneSettings,
  deviceZone: string,
): TimeZoneSettings => {
  if (settings.zones.includes(DEVICE_ZONE)) {
    return settings;
  }
  const own = settings.zones.find((zone) => canonicalZoneId(zone) === canonicalZoneId(deviceZone));
  if (own !== undefined) {
    return {
      primary: settings.primary === own ? DEVICE_ZONE : settings.primary,
      zones: settings.zones.map((zone) => (zone === own ? DEVICE_ZONE : zone)),
    };
  }
  const zones = [DEVICE_ZONE, ...settings.zones];
  while (zones.length > MAX_TIME_ZONES) {
    let drop = zones.length - 1;
    while (zones[drop] === settings.primary) {
      drop -= 1;
    }
    zones.splice(drop, 1);
  }
  return { primary: settings.primary, zones };
};

/** Appends a zone; a no-op at the cap or when it is already present. */
export const withZoneAdded = (settings: TimeZoneSettings, zone: string): TimeZoneSettings =>
  settings.zones.includes(zone) || settings.zones.length >= MAX_TIME_ZONES
    ? settings
    : { primary: settings.primary, zones: [...settings.zones, zone] };

/**
 * Drops a zone; the device entry stays whatever is asked. Removing the
 * primary promotes the first remaining zone, the device entry by
 * construction.
 */
export const withZoneRemoved = (settings: TimeZoneSettings, zone: string): TimeZoneSettings => {
  if (isDeviceZone(zone)) {
    return settings;
  }
  const zones = settings.zones.filter((candidate) => candidate !== zone);
  if (zones.length === 0 || zones.length === settings.zones.length) {
    return settings;
  }
  return { primary: zones.includes(settings.primary) ? settings.primary : zones[0]!, zones };
};

/** Makes a member zone primary; a no-op for a zone not in the list. */
export const withPrimary = (settings: TimeZoneSettings, zone: string): TimeZoneSettings =>
  settings.zones.includes(zone) ? { primary: zone, zones: settings.zones } : settings;
