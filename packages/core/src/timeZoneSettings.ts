import { Schema } from 'effect';
import { isValidTimeZone, MAX_TIME_ZONES } from './time/zones.ts';

/**
 * Device-local: the IANA zones this device draws, one of them primary. The
 * primary zone replaces the device zone for everything the UI draws (hour
 * axis, event placement, "today", editors); the others annotate the gutter,
 * event blocks and the editor. Stored in device_settings, never synced.
 */
export const TimeZoneSettings = Schema.Struct({
  /** The zone the grid, editors and "today" use; one of `zones`. */
  primary: Schema.String,
  /** 1..MAX_TIME_ZONES unique IANA ids, in the order the gutter shows them. */
  zones: Schema.Array(Schema.String).pipe(
    Schema.check(Schema.isLengthBetween(1, MAX_TIME_ZONES), Schema.isUnique()),
  ),
}).pipe(
  Schema.check(
    Schema.makeFilter((settings) =>
      settings.zones.includes(settings.primary)
        ? undefined
        : { issue: 'primary must be one of zones', path: ['primary'] },
    ),
    Schema.makeFilter((settings) => {
      const unknown = settings.zones.find((zone) => !isValidTimeZone(zone));
      return unknown === undefined
        ? undefined
        : { issue: `unknown time zone ${unknown}`, path: ['zones'] };
    }),
  ),
);
export type TimeZoneSettings = typeof TimeZoneSettings.Type;

/** Nothing stored: a single zone, the device's. */
export const defaultTimeZoneSettings = (deviceZone: string): TimeZoneSettings => ({
  primary: deviceZone,
  zones: [deviceZone],
});

/** The non-primary zones, in settings order. */
export const secondaryZones = (settings: TimeZoneSettings): ReadonlyArray<string> =>
  settings.zones.filter((zone) => zone !== settings.primary);

/** Appends a zone; a no-op at the cap or when it is already present. */
export const withZoneAdded = (settings: TimeZoneSettings, zone: string): TimeZoneSettings =>
  settings.zones.includes(zone) || settings.zones.length >= MAX_TIME_ZONES
    ? settings
    : { primary: settings.primary, zones: [...settings.zones, zone] };

/**
 * Drops a zone. The list never empties, and removing the primary promotes
 * the first remaining zone.
 */
export const withZoneRemoved = (settings: TimeZoneSettings, zone: string): TimeZoneSettings => {
  const zones = settings.zones.filter((candidate) => candidate !== zone);
  if (zones.length === 0 || zones.length === settings.zones.length) {
    return settings;
  }
  return { primary: zones.includes(settings.primary) ? settings.primary : zones[0]!, zones };
};

/** Makes a member zone primary; a no-op for a zone not in the list. */
export const withPrimary = (settings: TimeZoneSettings, zone: string): TimeZoneSettings =>
  settings.zones.includes(zone) ? { primary: zone, zones: settings.zones } : settings;
