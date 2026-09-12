import { readFileSync } from 'node:fs';
import {
  ContactsClient,
  contactsClientFrom,
  type ContactsClientShape,
  makeFakeContactsClient,
} from '@calendar/contacts';
import { Layer } from 'effect';
import { helperTransport } from './helperProcess.ts';

/**
 * CALENDAR_CONTACTS=fixture: the e2e harness hands the app a JSON address
 * book (contacts + birthdays) and the in-memory fake serves it as if the
 * user had granted access — device rows reach the UI without the helper,
 * a TCC prompt, or a developer's real contacts.
 */
const fixtureClient = (): ContactsClientShape | undefined => {
  const path = process.env['CALENDAR_CONTACTS_FIXTURE'];
  if (process.env['CALENDAR_CONTACTS'] !== 'fixture' || !path) {
    return undefined;
  }
  const fixture = JSON.parse(readFileSync(path, 'utf8')) as Parameters<
    typeof makeFakeContactsClient
  >[0];
  return makeFakeContactsClient({ ...fixture, authorization: 'authorized' }).client;
};

/**
 * ContactsClient over the Swift helper: every `contacts.*` method is one
 * stdio request. Without a helper binary the client reports
 * 'unavailable' instead of failing; see helperTransport for the kill
 * switch that keeps the e2e suite away from a developer's address book.
 */
export const desktopContactsClient: ContactsClientShape =
  fixtureClient() ?? contactsClientFrom(helperTransport('CALENDAR_CONTACTS'));

export const desktopContactsLayer: Layer.Layer<ContactsClient> = Layer.succeed(
  ContactsClient,
  desktopContactsClient,
);
