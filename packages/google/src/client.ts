import { Context, Effect, Layer } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import {
  GcalCalendarListEntry,
  GcalCalendarListPage,
  GcalColors,
  GcalEvent,
  GcalEventsPage,
  type GcalEventInput,
  type GcalEventPatch,
} from './apiTypes.ts';
import { NotFoundError } from './errors.ts';
import { TokenManager } from './oauth/tokenManager.ts';
import { definedParams, makeRequestCore, type GoogleRequestError } from './requestCore.ts';

const BASE_URL = 'https://www.googleapis.com/calendar/v3';

export type { GoogleRequestError } from './requestCore.ts';

/** Google's `sendUpdates`: whether guests get emailed about a change. */
export type GuestNotificationMode = 'all' | 'none';

/**
 * The `sendUpdates` policy for writes to events with guests. The app never
 * asks — guests are always told — so the default is 'all'; the live test
 * suites provide 'none' so their throwaway guests never get mail.
 */
export const GuestNotifications = Context.Reference<GuestNotificationMode>(
  'google/GuestNotifications',
  { defaultValue: () => 'all' },
);

export interface ListEventsParams {
  readonly maxResults?: number | undefined;
  readonly pageToken?: string | undefined;
  readonly syncToken?: string | undefined;
  readonly timeMax?: string | undefined;
  readonly timeMin?: string | undefined;
}

export interface GoogleCalendarClientShape {
  readonly deleteEvent: (params: {
    readonly accountId: string;
    readonly baseEtag?: string | undefined;
    readonly calendarId: string;
    readonly eventId: string;
  }) => Effect.Effect<void, GoogleRequestError>;
  readonly getColors: (accountId: string) => Effect.Effect<GcalColors, GoogleRequestError>;
  /**
   * events.get: one event as Google has it now (a cancelled one comes back
   * with `status: 'cancelled'`). 404 and 410 both mean gone → NotFoundError.
   */
  readonly getEvent: (params: {
    readonly accountId: string;
    readonly calendarId: string;
    readonly eventId: string;
  }) => Effect.Effect<GcalEvent, GoogleRequestError>;
  readonly insertEvent: (params: {
    readonly accountId: string;
    readonly calendarId: string;
    readonly event: GcalEventInput;
    /** Google emails guests about the change ('none' suppresses it); ignored without attendees. */
    readonly sendUpdates?: GuestNotificationMode | undefined;
  }) => Effect.Effect<GcalEvent, GoogleRequestError>;
  readonly listCalendars: (params: {
    readonly accountId: string;
    readonly pageToken?: string | undefined;
    readonly syncToken?: string | undefined;
  }) => Effect.Effect<GcalCalendarListPage, GoogleRequestError>;
  readonly listEvents: (params: {
    readonly accountId: string;
    readonly calendarId: string;
    readonly params: ListEventsParams;
  }) => Effect.Effect<GcalEventsPage, GoogleRequestError>;
  /**
   * events.move: re-homes an event (a whole series — instance ids are
   * refused) into another calendar of the same account, keeping its id,
   * guests, conference and exceptions. Organizer only.
   */
  readonly moveEvent: (params: {
    readonly accountId: string;
    readonly calendarId: string;
    readonly destination: string;
    readonly eventId: string;
    /** Google emails guests about the change ('none' suppresses it); ignored without attendees. */
    readonly sendUpdates?: GuestNotificationMode | undefined;
  }) => Effect.Effect<GcalEvent, GoogleRequestError>;
  readonly patchCalendarListEntry: (params: {
    readonly accountId: string;
    readonly backgroundColor: string;
    readonly calendarId: string;
    readonly foregroundColor: string;
  }) => Effect.Effect<GcalCalendarListEntry, GoogleRequestError>;
  readonly patchEvent: (params: {
    readonly accountId: string;
    readonly baseEtag?: string | undefined;
    readonly calendarId: string;
    readonly event: GcalEventPatch;
    readonly eventId: string;
    /** Google emails guests about the change ('none' suppresses it); ignored without attendees. */
    readonly sendUpdates?: GuestNotificationMode | undefined;
  }) => Effect.Effect<GcalEvent, GoogleRequestError>;
}

const make: Effect.Effect<GoogleCalendarClientShape, never, HttpClient.HttpClient | TokenManager> =
  Effect.gen(function* () {
    const { executeAuthed, failForStatus, requestJson } = yield* makeRequestCore;

    const eventsUrl = (calendarId: string, suffix = ''): string =>
      `${BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events${suffix}`;

    const shape: GoogleCalendarClientShape = {
      deleteEvent: ({ accountId, baseEtag, calendarId, eventId }) =>
        Effect.gen(function* () {
          let request = HttpClientRequest.delete(
            eventsUrl(calendarId, `/${encodeURIComponent(eventId)}`),
          );
          if (baseEtag) {
            request = HttpClientRequest.setHeader(request, 'if-match', baseEtag);
          }
          const response = yield* executeAuthed(accountId, request);
          if (response.status >= 400) {
            return yield* failForStatus(response, { calendarId, eventId });
          }
        }),

      getColors: (accountId) =>
        requestJson(accountId, HttpClientRequest.get(`${BASE_URL}/colors`), GcalColors),

      getEvent: ({ accountId, calendarId, eventId }) =>
        requestJson(
          accountId,
          HttpClientRequest.get(eventsUrl(calendarId, `/${encodeURIComponent(eventId)}`)),
          GcalEvent,
          { calendarId, eventId },
        ).pipe(
          // failForStatus reads 410 as an expired sync token — for a single
          // event it means deleted.
          Effect.catchTag('SyncTokenExpiredError', () =>
            Effect.fail(new NotFoundError({ resource: eventId })),
          ),
        ),

      insertEvent: ({ accountId, calendarId, event, sendUpdates }) =>
        requestJson(
          accountId,
          HttpClientRequest.post(eventsUrl(calendarId)).pipe(
            HttpClientRequest.setUrlParams(definedParams({ sendUpdates })),
            HttpClientRequest.bodyJsonUnsafe(event),
          ),
          GcalEvent,
          { calendarId },
        ),

      listCalendars: ({ accountId, pageToken, syncToken }) =>
        requestJson(
          accountId,
          HttpClientRequest.get(`${BASE_URL}/users/me/calendarList`).pipe(
            HttpClientRequest.setUrlParams(
              definedParams({
                maxResults: 250,
                pageToken,
                showDeleted: 'true',
                syncToken,
              }),
            ),
          ),
          GcalCalendarListPage,
        ),

      listEvents: ({ accountId, calendarId, params }) =>
        requestJson(
          accountId,
          HttpClientRequest.get(eventsUrl(calendarId)).pipe(
            HttpClientRequest.setUrlParams(
              definedParams({
                maxResults: params.maxResults ?? 2500,
                pageToken: params.pageToken,
                showDeleted: 'true',
                // Sync tokens encode the original filters; incremental calls
                // must send the token alone.
                ...(params.syncToken
                  ? { syncToken: params.syncToken }
                  : {
                      singleEvents: 'false',
                      timeMax: params.timeMax,
                      timeMin: params.timeMin,
                    }),
              }),
            ),
          ),
          GcalEventsPage,
          { calendarId },
        ),

      moveEvent: ({ accountId, calendarId, destination, eventId, sendUpdates }) =>
        requestJson(
          accountId,
          HttpClientRequest.post(
            eventsUrl(calendarId, `/${encodeURIComponent(eventId)}/move`),
          ).pipe(HttpClientRequest.setUrlParams(definedParams({ destination, sendUpdates }))),
          GcalEvent,
          { calendarId, eventId },
        ),

      patchCalendarListEntry: ({ accountId, backgroundColor, calendarId, foregroundColor }) =>
        requestJson(
          accountId,
          HttpClientRequest.patch(
            `${BASE_URL}/users/me/calendarList/${encodeURIComponent(calendarId)}`,
          ).pipe(
            HttpClientRequest.setUrlParam('colorRgbFormat', 'true'),
            HttpClientRequest.bodyJsonUnsafe({ backgroundColor, foregroundColor }),
          ),
          GcalCalendarListEntry,
          { calendarId },
        ),

      patchEvent: ({ accountId, baseEtag, calendarId, event, eventId, sendUpdates }) => {
        let request = HttpClientRequest.patch(
          eventsUrl(calendarId, `/${encodeURIComponent(eventId)}`),
        ).pipe(
          HttpClientRequest.setUrlParams(definedParams({ sendUpdates })),
          HttpClientRequest.bodyJsonUnsafe(event),
        );
        if (baseEtag) {
          request = HttpClientRequest.setHeader(request, 'if-match', baseEtag);
        }
        return requestJson(accountId, request, GcalEvent, {
          calendarId,
          eventId,
        });
      },
    };

    return shape;
  });

export class GoogleCalendarClient extends Context.Service<
  GoogleCalendarClient,
  GoogleCalendarClientShape
>()('google/CalendarClient') {
  static readonly layer: Layer.Layer<
    GoogleCalendarClient,
    never,
    HttpClient.HttpClient | TokenManager
  > = Layer.effect(GoogleCalendarClient)(make);
}
