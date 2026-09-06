import { Context, Effect, Layer } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { GcalPeoplePage } from './apiTypes.ts';
import { SyncTokenExpiredError } from './errors.ts';
import { TokenManager } from './oauth/tokenManager.ts';
import { definedParams, makeRequestCore, type GoogleRequestError } from './requestCore.ts';

/** Separate host from Calendar/Tasks — People is its own service. */
const BASE_URL = 'https://people.googleapis.com/v1';
/** The API's maximum; address books rarely need a second page. */
const PAGE_SIZE = 1000;
/** otherContacts.list only permits names, emailAddresses, phoneNumbers. */
const FIELDS = 'names,emailAddresses';

/**
 * People reports an expired sync token as 400 EXPIRED_SYNC_TOKEN (the
 * Calendar API uses 410, which requestCore already maps); fold both into
 * the one error the engine resyncs on.
 */
const expiredTokenAs400 = (error: GoogleRequestError): GoogleRequestError =>
  error._tag === 'GoogleApiError' &&
  error.status === 400 &&
  error.message.includes('EXPIRED_SYNC_TOKEN')
    ? new SyncTokenExpiredError({ calendarId: '' })
    : error;

export interface ListPeopleParams {
  readonly accountId: string;
  readonly pageToken?: string | undefined;
  /** From the previous pass's nextSyncToken; omitted on a full pass. */
  readonly syncToken?: string | undefined;
}

export interface GooglePeopleClientShape {
  /** Saved contacts (`connections`), with `requestSyncToken` for incremental passes. */
  readonly listConnections: (
    params: ListPeopleParams,
  ) => Effect.Effect<GcalPeoplePage, GoogleRequestError>;
  /** "Other contacts" — people you've emailed; what Google Calendar's own suggestions use. */
  readonly listOtherContacts: (
    params: ListPeopleParams,
  ) => Effect.Effect<GcalPeoplePage, GoogleRequestError>;
}

const make: Effect.Effect<GooglePeopleClientShape, never, HttpClient.HttpClient | TokenManager> =
  Effect.gen(function* () {
    const { requestJson } = yield* makeRequestCore;

    const list = (
      url: string,
      fieldsParam: 'personFields' | 'readMask',
      { accountId, pageToken, syncToken }: ListPeopleParams,
    ) =>
      requestJson(
        accountId,
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setUrlParams(
            definedParams({
              [fieldsParam]: FIELDS,
              pageSize: PAGE_SIZE,
              pageToken,
              requestSyncToken: 'true',
              syncToken,
            }),
          ),
        ),
        GcalPeoplePage,
      ).pipe(Effect.mapError(expiredTokenAs400));

    return {
      listConnections: (params) =>
        list(`${BASE_URL}/people/me/connections`, 'personFields', params),
      listOtherContacts: (params) => list(`${BASE_URL}/otherContacts`, 'readMask', params),
    };
  });

export class GooglePeopleClient extends Context.Service<
  GooglePeopleClient,
  GooglePeopleClientShape
>()('google/PeopleClient') {
  static readonly layer: Layer.Layer<
    GooglePeopleClient,
    never,
    HttpClient.HttpClient | TokenManager
  > = Layer.effect(GooglePeopleClient)(make);
}
