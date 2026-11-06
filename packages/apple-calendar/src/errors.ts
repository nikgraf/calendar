import { Data } from 'effect';
import type { CalendarAuthorization } from './protocol.ts';

/** EventKit events access is missing (denied/restricted/not asked yet). */
export class AppleCalendarAccessError extends Data.TaggedError('AppleCalendarAccessError')<{
  readonly authorization: CalendarAuthorization;
}> {}

/** No native calendar bridge on this build/platform (helper missing, module absent, kill switch). */
export class AppleCalendarUnavailableError extends Data.TaggedError(
  'AppleCalendarUnavailableError',
)<{
  readonly message: string;
}> {}

/** The bridge answered with an error (save failure, unknown id, read-only calendar…). */
export class AppleCalendarRequestError extends Data.TaggedError('AppleCalendarRequestError')<{
  readonly message: string;
  readonly method: string;
}> {}

export type AppleCalendarError =
  | AppleCalendarAccessError
  | AppleCalendarRequestError
  | AppleCalendarUnavailableError;

/** The event (or occurrence) is gone — a delete of it has nothing left to do. */
export const isNotFound = (error: AppleCalendarError): boolean =>
  error._tag === 'AppleCalendarRequestError' && error.message.startsWith('notFound:');
