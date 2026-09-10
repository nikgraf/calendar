import { Context, Effect, Layer } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import {
  GcalCalendarListEntry,
  GcalCalendarListPage,
  GcalColors,
  GcalEvent,
  GcalEventsPage,
  type GcalEventInput,
} from './apiTypes.ts';
import { TokenManager } from './oauth/tokenManager.ts';
import { definedParams, makeRequestCore, type GoogleRequestError } from './requestCore.ts';

const BASE_URL = 'https://www.googleapis.com/calendar/v3';

export type { GoogleRequestError } from './requestCore.ts';

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
  readonly insertEvent: (params: {
    readonly accountId: string;
    readonly calendarId: string;
    readonly event: GcalEventInput;
    /** Google emails guests about the change; ignored without attendees. */
    readonly sendUpdates?: 'all' | undefined;
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
    readonly event: Partial<GcalEventInput>;
    readonly eventId: string;
    /** Google emails guests about the change; ignored without attendees. */
    readonly sendUpdates?: 'all' | undefined;
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
