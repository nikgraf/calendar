import { buildEventTimes, type EditorTimeFields } from '../editor/eventDraft.ts';
import { Temporal } from './temporal.ts';
import { zoneCity } from './zones.ts';

const clock = (time: Temporal.PlainTime, options: Intl.DateTimeFormatOptions): string =>
  time.toLocaleString('en-US', options);

/** '7 AM', or '1:30 PM' for a zone offset by minutes. */
const hourLabel = (time: Temporal.PlainTime): string =>
  time.minute === 0
    ? clock(time, { hour: 'numeric' })
    : clock(time, { hour: 'numeric', minute: '2-digit' });

/**
 * The hour label `zone` shows for the row that is `hour`:00 on `date` in
 * the primary zone. Built from the instant, so half-hour zones show
 * minutes; the default 'compatible' disambiguation absorbs a DST gap.
 */
export const zoneHourLabel = (
  date: Temporal.PlainDate,
  hour: number,
  primaryZone: string,
  zone: string,
): string =>
  hourLabel(
    date
      .toZonedDateTime({ plainTime: new Temporal.PlainTime(hour), timeZone: primaryZone })
      .withTimeZone(zone)
      .toPlainTime(),
  );

/** The gutter's second line: every secondary zone's hour, in settings order, '·'-joined. */
export const secondaryHourLabels = (
  date: Temporal.PlainDate,
  hour: number,
  primaryZone: string,
  zones: ReadonlyArray<string>,
): string => zones.map((zone) => zoneHourLabel(date, hour, primaryZone, zone)).join(' · ');

const zonedTime = (epochMs: number, zone: string): Temporal.PlainTime =>
  Temporal.Instant.fromEpochMilliseconds(epochMs).toZonedDateTimeISO(zone).toPlainTime();

const period = (time: Temporal.PlainTime): string => (time.hour < 12 ? 'AM' : 'PM');

const minutes = (time: Temporal.PlainTime): string =>
  clock(time, { hour: 'numeric', minute: '2-digit' }).replace(/ (AM|PM)$/, '');

/** '2:00 – 3:00 PM' when both ends share a period, else '11:00 PM – 12:00 AM'. */
export const formatZoneTimeRange = (startUtc: number, endUtc: number, zone: string): string => {
  const start = zonedTime(startUtc, zone);
  const end = zonedTime(endUtc, zone);
  return period(start) === period(end) && endUtc - startUtc < 24 * 60 * 60 * 1000
    ? `${minutes(start)} – ${minutes(end)} ${period(end)}`
    : `${minutes(start)} ${period(start)} – ${minutes(end)} ${period(end)}`;
};

/** '2:00 – 3:00 PM Los Angeles · 11:00 PM – 12:00 AM Tokyo' — the chip and editor line. */
export const formatZoneRange = (
  startUtc: number,
  endUtc: number,
  zones: ReadonlyArray<string>,
): string =>
  zones
    .map((zone) => `${formatZoneTimeRange(startUtc, endUtc, zone)} ${zoneCity(zone)}`)
    .join(' · ');

/**
 * The editor's helper line for a draft, or null when there is nothing to
 * show: all-day, no secondary zones, or a draft that does not build yet.
 */
export const draftZoneRange = (
  fields: EditorTimeFields,
  primaryZone: string,
  zones: ReadonlyArray<string>,
): string | null => {
  if (fields.isAllDay || zones.length === 0 || !fields.date || !fields.startTime) {
    return null;
  }
  try {
    const times = buildEventTimes(fields, primaryZone);
    return formatZoneRange(times.startUtc, times.endUtc, zones);
  } catch {
    return null;
  }
};
