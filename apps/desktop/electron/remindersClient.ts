import {
  changesFromSubscription,
  makeRemindersClient,
  RemindersClient,
  type RemindersClientShape,
  unavailableRemindersClient,
} from '@calendar/reminders';
import { Layer } from 'effect';
import { callHelper, helperAvailable, onHelperEvent } from './helperProcess.ts';

/**
 * RemindersClient over the Swift helper: every `reminders.*` method is one
 * stdio request. Without a helper binary (a dev checkout that never ran
 * build:helper) the client reports 'unavailable' instead of failing
 * spawn on every sync tick. CALENDAR_REMINDERS=off makes EventKit
 * unreachable on purpose: the e2e suite seeds Apple rows straight into
 * SQLite and must never let a real sync (or a TCC prompt) touch them on
 * a developer's Mac.
 */
export const desktopRemindersClient: RemindersClientShape =
  process.env['CALENDAR_REMINDERS'] === 'off'
    ? unavailableRemindersClient('disabled by CALENDAR_REMINDERS=off')
    : helperAvailable()
      ? makeRemindersClient(
          (method, params) => callHelper(method, params),
          changesFromSubscription((listener) => onHelperEvent('reminders.changed', listener)),
        )
      : unavailableRemindersClient('helper binary missing — run build:helper');

export const desktopRemindersLayer: Layer.Layer<RemindersClient> = Layer.succeed(
  RemindersClient,
  desktopRemindersClient,
);
