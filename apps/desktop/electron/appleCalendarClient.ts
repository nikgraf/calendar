import { readFileSync } from 'node:fs';
import {
  AppleCalendarClient,
  appleCalendarClientFrom,
  type AppleCalendarClientShape,
  makeFakeAppleCalendarClient,
} from '@calendar/apple-calendar';
import { Layer } from 'effect';
import { helperTransport } from './helperProcess.ts';

/**
 * CALENDAR_APPLE_CALENDAR=fixture: an in-memory EventKit seeded from the
 * JSON at CALENDAR_APPLE_CALENDAR_FIXTURE ({ calendars, events }) — the e2e
 * suite's Apple events, which exist nowhere on disk to seed otherwise.
 */
const fixtureClient = (): AppleCalendarClientShape | undefined => {
  const path = process.env['CALENDAR_APPLE_CALENDAR_FIXTURE'];
  if (process.env['CALENDAR_APPLE_CALENDAR'] !== 'fixture' || !path) {
    return undefined;
  }
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as Parameters<
    typeof makeFakeAppleCalendarClient
  >[0];
  return makeFakeAppleCalendarClient({ ...fixture, authorization: 'fullAccess' }).client;
};

/**
 * AppleCalendarClient over the Swift helper: every `calendar.*` method is
 * one stdio request. Without a helper binary the client reports
 * 'unavailable'; CALENDAR_APPLE_CALENDAR=off makes it unreachable on
 * purpose (see helperTransport).
 */
export const desktopAppleCalendarClient: AppleCalendarClientShape =
  fixtureClient() ?? appleCalendarClientFrom(helperTransport('CALENDAR_APPLE_CALENDAR'));

export const desktopAppleCalendarLayer: Layer.Layer<AppleCalendarClient> = Layer.succeed(
  AppleCalendarClient,
  desktopAppleCalendarClient,
);
