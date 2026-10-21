import { existsSync, readFileSync } from 'node:fs';
import {
  makeFakeRemindersClient,
  RemindersClient,
  remindersClientFrom,
  type RemindersClientShape,
} from '@calendar/reminders';
import { Duration, Effect, Layer } from 'effect';
import { helperTransport } from './helperProcess.ts';

/** How often a held fixture write checks its marker file. */
const HOLD_POLL = Duration.millis(50);

/**
 * Waits while the marker file exists: a spec holds a fixture write's
 * reply, as a slow EventKit would, to act while the save is under way.
 */
const whileHeld = (path: string): Effect.Effect<void> =>
  Effect.suspend(() =>
    existsSync(path) ? Effect.sleep(HOLD_POLL).pipe(Effect.andThen(whileHeld(path))) : Effect.void,
  );

const fixtureClient = (): RemindersClientShape | undefined => {
  const path = process.env['CALENDAR_REMINDERS_FIXTURE'];
  if (process.env['CALENDAR_REMINDERS'] !== 'fixture' || !path) {
    return undefined;
  }
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as Parameters<
    typeof makeFakeRemindersClient
  >[0];
  const client = makeFakeRemindersClient({ ...fixture, authorization: 'fullAccess' }).client;
  const hold = process.env['CALENDAR_REMINDERS_HOLD'];
  if (!hold) {
    return client;
  }
  const held = whileHeld(hold);
  return {
    ...client,
    create: (params) => held.pipe(Effect.andThen(client.create(params))),
    delete: (params) => held.pipe(Effect.andThen(client.delete(params))),
    setCompleted: (params) => held.pipe(Effect.andThen(client.setCompleted(params))),
    update: (params) => held.pipe(Effect.andThen(client.update(params))),
  };
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
