import { RemindersClient, remindersClientFrom, remindersLayer } from '@calendar/reminders';
import { Layer } from 'effect';
import { helperTransport } from './helperProcess.ts';

/**
 * RemindersClient over the Swift helper: every `reminders.*` method is one
 * stdio request. Without a helper binary (a dev checkout that never ran
 * build:helper) the client reports 'unavailable' instead of failing
 * spawn on every sync tick; see helperTransport for the kill switch.
 */
export const desktopRemindersClient = remindersClientFrom(helperTransport('CALENDAR_REMINDERS'));

export const desktopRemindersLayer: Layer.Layer<RemindersClient> = remindersLayer(
  helperTransport('CALENDAR_REMINDERS'),
);
