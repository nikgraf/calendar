import { ContactsClient, contactsClientFrom, contactsLayer } from '@calendar/contacts';
import { Layer } from 'effect';
import { helperTransport } from './helperProcess.ts';

/**
 * ContactsClient over the Swift helper: every `contacts.*` method is one
 * stdio request. Without a helper binary the client reports
 * 'unavailable' instead of failing; see helperTransport for the kill
 * switch that keeps the e2e suite away from a developer's address book.
 */
export const desktopContactsClient = contactsClientFrom(helperTransport('CALENDAR_CONTACTS'));

export const desktopContactsLayer: Layer.Layer<ContactsClient> = contactsLayer(
  helperTransport('CALENDAR_CONTACTS'),
);
