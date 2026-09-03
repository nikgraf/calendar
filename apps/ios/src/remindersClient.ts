import {
  makeRemindersClient,
  RemindersClient,
  type RemindersClientShape,
  unavailableRemindersClient,
} from '@calendar/reminders';
import { Layer } from 'effect';
import { loadRemindersModule } from '../modules/solunivo-reminders/index.ts';

/**
 * RemindersClient over the local Expo module (apps/ios/modules/
 * solunivo-reminders). A dev client built before the module existed
 * reports 'unavailable' instead of crashing at import.
 */
const native = loadRemindersModule();

export const iosRemindersClient: RemindersClientShape = native
  ? makeRemindersClient((method, params) => native.invoke(method, params))
  : unavailableRemindersClient('reminders module not in this build — rebuild the dev client');

export const iosRemindersLayer: Layer.Layer<RemindersClient> = Layer.succeed(
  RemindersClient,
  iosRemindersClient,
);
