import {
  AppleCalendarClient,
  appleCalendarClientFrom,
  type AppleCalendarClientShape,
} from '@calendar/apple-calendar';
import type { BridgeTransport } from '@calendar/core';
import { Layer } from 'effect';
import { loadAppleCalendarModule } from '../modules/solunivo-apple-calendar/index.ts';

/**
 * AppleCalendarClient over the local Expo module (apps/ios/modules/
 * solunivo-apple-calendar). A dev client built before the module existed
 * reports 'unavailable' instead of crashing at import.
 */
const native = loadAppleCalendarModule();

const transport: BridgeTransport | { readonly unavailable: string } = native
  ? {
      invoke: (method, params) => native.invoke(method, params),
      // The module emits one event; the transport's event name is the
      // helper's, so map it here.
      subscribe: (_event, listener) => {
        const subscription = native.addListener('calendarChanged', listener);
        return () => subscription.remove();
      },
    }
  : { unavailable: 'calendar module not in this build — rebuild the dev client' };

export const iosAppleCalendarClient: AppleCalendarClientShape = appleCalendarClientFrom(transport);

export const iosAppleCalendarLayer: Layer.Layer<AppleCalendarClient> = Layer.succeed(
  AppleCalendarClient,
  iosAppleCalendarClient,
);
