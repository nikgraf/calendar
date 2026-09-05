import { Schema } from 'effect';

/**
 * The device-contacts JSON contract shared by three implementations: this
 * TS client, the macOS Swift helper (`contacts.*` stdio methods), and the
 * iOS Expo module. Both native sides are generated from one Swift source
 * (packages/contacts/swift/ContactsBridge.swift); the schemas here decode
 * what comes back so a drift on either side fails loudly at the boundary.
 *
 * The bridge is read-only and deliberately tiny: names and email
 * addresses are all the invitee typeahead needs. No photos, no phone
 * numbers, nothing leaves the device.
 */

export const ContactsAuthorization = Schema.Literals([
  'authorized',
  'denied',
  /** iOS 18 partial access: the user picked a subset — still usable. */
  'limited',
  'notDetermined',
  'restricted',
  'unavailable',
]);
export type ContactsAuthorization = typeof ContactsAuthorization.Type;

/** One row per (contact, email address); a contact with three emails is three rows. */
export const DeviceContactJson = Schema.Struct({
  contactId: Schema.String,
  displayName: Schema.optional(Schema.String),
  email: Schema.String,
});
export type DeviceContactJson = typeof DeviceContactJson.Type;

export const StatusResult = Schema.Struct({ authorization: ContactsAuthorization });
export const RequestAccessResult = Schema.Struct({ granted: Schema.Boolean });
/**
 * Always the complete address book (contacts that have at least one
 * email). CNContactStore offers no cheap delta and address books are
 * small, so the backend just replaces its in-memory copy.
 */
export const SnapshotResult = Schema.Struct({ contacts: Schema.Array(DeviceContactJson) });
export type SnapshotResult = typeof SnapshotResult.Type;

/** Method names as the native sides dispatch them. */
export const CONTACTS_METHODS = {
  requestAccess: 'contacts.requestAccess',
  snapshot: 'contacts.snapshot',
  status: 'contacts.status',
} as const;

/** The id-less helper line / Expo event fired on CNContactStoreDidChange. */
export const CONTACTS_CHANGED_EVENT = 'contacts.changed';
