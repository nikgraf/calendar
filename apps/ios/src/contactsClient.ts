import { ContactsClient, contactsClientFrom, type ContactsClientShape } from '@calendar/contacts';
import type { BridgeTransport } from '@calendar/core';
import { Layer } from 'effect';
import { loadContactsModule } from '../modules/solunivo-contacts/index.ts';

/**
 * ContactsClient over the local Expo module (apps/ios/modules/
 * solunivo-contacts). A dev client built before the module existed
 * reports 'unavailable' instead of crashing at import.
 */
const native = loadContactsModule();

const transport: BridgeTransport | { readonly unavailable: string } = native
  ? {
      invoke: (method, params) => native.invoke(method, params),
      subscribe: (_event, listener) => {
        const subscription = native.addListener('contactsChanged', listener);
        return () => subscription.remove();
      },
    }
  : { unavailable: 'contacts module not in this build — rebuild the dev client' };

export const iosContactsClient: ContactsClientShape = contactsClientFrom(transport);

export const iosContactsLayer: Layer.Layer<ContactsClient> = Layer.succeed(
  ContactsClient,
  iosContactsClient,
);
