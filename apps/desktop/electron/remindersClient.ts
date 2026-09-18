import { readFileSync } from 'node:fs';
import {
  makeFakeRemindersClient,
  RemindersClient,
  remindersClientFrom,
  type RemindersClientShape,
} from '@calendar/reminders';
import { Layer } from 'effect';
import { helperTransport } from './helperProcess.ts';

const fixtureClient = (): RemindersClientShape | undefined => {
  const path = process.env['CALENDAR_REMINDERS_FIXTURE'];
  if (process.env['CALENDAR_REMINDERS'] !== 'fixture' || !path) {
    return undefined;
  }
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as Parameters<
    typeof makeFakeRemindersClient
  >[0];
  return makeFakeRemindersClient({ ...fixture, authorization: 'fullAccess' }).client;
};

/**
 * RemindersClient over the Swift helper: every `reminders.*` method is one
 * stdio request. Without a helper binary (a dev checkout that never ran
 * build:helper) the client reports 'unavailable' instead of failing
 * spawn on every sync tick; see helperTransport for the kill switch.
 */
export const desktopRemindersClient: RemindersClientShape =
  fixtureClient() ?? remindersClientFrom(helperTransport('CALENDAR_REMINDERS'));

export const desktopRemindersLayer: Layer.Layer<RemindersClient> = Layer.succeed(
  RemindersClient,
  desktopRemindersClient,
);
