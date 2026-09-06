import {
  ContactsClient,
  type ContactsClientShape,
  makeContactsClient,
  unavailableContactsClient,
} from '@calendar/contacts';
import { changesFromSubscription } from '@calendar/reminders';
import { Layer } from 'effect';
import { loadContactsModule } from '../modules/solunivo-contacts/index.ts';

/**
 * ContactsClient over the local Expo module (apps/ios/modules/
 * solunivo-contacts). A dev client built before the module existed
 * reports 'unavailable' instead of crashing at import.
 */
const native = loadContactsModule();

export const iosContactsClient: ContactsClientShape = native
  ? makeContactsClient(
      (method, params) => native.invoke(method, params),
      changesFromSubscription((listener) => {
        const subscription = native.addListener('contactsChanged', listener);
        return () => subscription.remove();
      }),
    )
  : unavailableContactsClient('contacts module not in this build — rebuild the dev client');

export const iosContactsLayer: Layer.Layer<ContactsClient> = Layer.succeed(
  ContactsClient,
  iosContactsClient,
);
