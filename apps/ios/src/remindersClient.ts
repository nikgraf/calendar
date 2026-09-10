import type { BridgeTransport } from '@calendar/core';
import {
  RemindersClient,
  remindersClientFrom,
  type RemindersClientShape,
} from '@calendar/reminders';
import { Layer } from 'effect';
import { loadRemindersModule } from '../modules/solunivo-reminders/index.ts';

/**
 * RemindersClient over the local Expo module (apps/ios/modules/
 * solunivo-reminders). A dev client built before the module existed
 * reports 'unavailable' instead of crashing at import.
 */
const native = loadRemindersModule();

const transport: BridgeTransport | { readonly unavailable: string } = native
  ? {
      invoke: (method, params) => native.invoke(method, params),
      // The module emits one event; the transport's event name is the
      // helper's, so map it here.
      subscribe: (_event, listener) => {
        const subscription = native.addListener('remindersChanged', listener);
        return () => subscription.remove();
      },
    }
  : { unavailable: 'reminders module not in this build — rebuild the dev client' };

export const iosRemindersClient: RemindersClientShape = remindersClientFrom(transport);

export const iosRemindersLayer: Layer.Layer<RemindersClient> = Layer.succeed(
  RemindersClient,
  iosRemindersClient,
);
