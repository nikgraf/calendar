import {
  type EventRecord,
  type GeoLocation,
  geoMatches,
  isMappableLocation,
  openInMapsUrl,
  toZonedDateTime,
} from '@calendar/core';
import { useLocationGeo } from './hooks.ts';

const wallTime = (epochMs: number, timeZone: string): string =>
  toZonedDateTime(epochMs, timeZone).toPlainTime().toString({ smallestUnit: 'minute' });

/**
 * What a read-only view of an event shows, straight from the record: the
 * values `useEventEditorModel` seeds its form with, minus the form. The
 * model seeds once, when the view mounts — a view that read them from it
 * kept showing the event as it was opened, whatever refresh landed after.
 * The times are wall clock in `timeZone` (empty for an all-day event).
 */
export const eventReadout = (event: EventRecord, timeZone: string) => ({
  /** Guests; rooms are not people. */
  attendees: (event.attendees ?? []).filter((attendee) => !attendee.isResource),
  date: event.startDate ?? toZonedDateTime(event.startUtc, timeZone).toPlainDate().toString(),
  description: event.description ?? '',
  endTime: event.isAllDay ? '' : wallTime(event.endUtc, timeZone),
  isAllDay: event.isAllDay,
  location: event.location ?? '',
  startTime: event.isAllDay ? '' : wallTime(event.startUtc, timeZone),
  title: event.title,
});

/** What a location map needs: the text, and coordinates for it once known. */
export interface EventPlace {
  readonly location: string;
  readonly mapGeo: GeoLocation | undefined;
  readonly mapLoading: boolean;
  /** Apple Maps link for the mapped place. */
  readonly mapsUrl: string | undefined;
}

/**
 * The map a read-only view draws for an event's location, from the
 * record: its own coordinates while they match the text, else an
 * on-device lookup of the text — the editor model's rule for the text it
 * opened with, kept current as the record changes.
 */
export const useEventPlace = (event: Pick<EventRecord, 'geo' | 'location'>): EventPlace => {
  const location = event.location ?? '';
  const own = geoMatches(event.geo, location) ? event.geo : undefined;
  const lookupLocation = own === undefined && isMappableLocation(location) ? location : '';
  const lookup = useLocationGeo(lookupLocation);
  const mapGeo =
    own ??
    (lookupLocation !== '' && geoMatches(lookup.geo ?? undefined, location)
      ? (lookup.geo ?? undefined)
      : undefined);
  return {
    location,
    mapGeo,
    mapLoading: lookupLocation !== '' && lookup.loading,
    mapsUrl: mapGeo ? openInMapsUrl(mapGeo) : undefined,
  };
};
