import { readFileSync } from 'node:fs';
import {
  AppleCalendarClient,
  appleCalendarClientFrom,
  type AppleCalendarClientShape,
  makeFakeAppleCalendarClient,
} from '@calendar/apple-calendar';
import { Layer } from 'effect';
import { afterHold } from './eventKitHold.ts';
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
  const client = makeFakeAppleCalendarClient({ ...fixture, authorization: 'fullAccess' }).client;
  // Its writes wait while a spec holds them (eventKitHold.ts).
  return {
    ...client,
    applyBatch: (params) => afterHold(client.applyBatch(params)),
    create: (params) => afterHold(client.create(params)),
    createCalendar: (params) => afterHold(client.createCalendar(params)),
    delete: (params) => afterHold(client.delete(params)),
    move: (params) => afterHold(client.move(params)),
    setColor: (params) => afterHold(client.setColor(params)),
    update: (params) => afterHold(client.update(params)),
  };
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
