import {
  ContactsClient,
  type ContactsClientShape,
  makeContactsClient,
  unavailableContactsClient,
} from '@calendar/contacts';
import { changesFromSubscription } from '@calendar/reminders';
import { Layer } from 'effect';
import { callHelper, helperAvailable, onHelperEvent } from './helperProcess.ts';

/**
 * ContactsClient over the Swift helper: every `contacts.*` method is one
 * stdio request. Without a helper binary the client reports
 * 'unavailable' instead of failing. CALENDAR_CONTACTS=off makes the
 * address book unreachable on purpose: the e2e suite must never trigger
 * a TCC prompt or read a developer's real contacts.
 */
export const desktopContactsClient: ContactsClientShape =
  process.env['CALENDAR_CONTACTS'] === 'off'
    ? unavailableContactsClient('disabled by CALENDAR_CONTACTS=off')
    : helperAvailable()
      ? makeContactsClient(
          (method, params) => callHelper(method, params),
          changesFromSubscription((listener) => onHelperEvent('contacts.changed', listener)),
        )
      : unavailableContactsClient('helper binary missing — run build:helper');

export const desktopContactsLayer: Layer.Layer<ContactsClient> = Layer.succeed(
  ContactsClient,
  desktopContactsClient,
);
