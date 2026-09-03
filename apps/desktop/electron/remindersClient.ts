import {
  makeRemindersClient,
  RemindersClient,
  type RemindersClientShape,
  unavailableRemindersClient,
} from '@calendar/reminders';
import { Layer } from 'effect';
import { callHelper, helperAvailable } from './helperProcess.ts';

/**
 * RemindersClient over the Swift helper: every `reminders.*` method is one
 * stdio request. Without a helper binary (a dev checkout that never ran
 * build:helper) the client reports 'unavailable' instead of failing
 * spawn on every sync tick.
 */
export const desktopRemindersClient: RemindersClientShape = helperAvailable()
  ? makeRemindersClient((method, params) => callHelper(method, params))
  : unavailableRemindersClient('helper binary missing — run build:helper');

export const desktopRemindersLayer: Layer.Layer<RemindersClient> = Layer.succeed(
  RemindersClient,
  desktopRemindersClient,
);
