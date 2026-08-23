import { Data } from 'effect';

/** Access/refresh token is unusable — the user must sign in again. */
export class ReauthRequiredError extends Data.TaggedError('ReauthRequiredError')<{
  readonly accountId: string;
}> {}

export class TokenRefreshError extends Data.TaggedError('TokenRefreshError')<{
  readonly accountId: string;
  readonly message: string;
}> {}

/** 403 rateLimitExceeded / 429. Retryable with backoff. */
export class RateLimitedError extends Data.TaggedError('RateLimitedError')<{
  readonly retryAfterMs?: number | undefined;
}> {}

/** 410 GONE on an incremental sync — the sync token is invalid; full resync. */
export class SyncTokenExpiredError extends Data.TaggedError('SyncTokenExpiredError')<{
  readonly calendarId: string;
}> {}

/** 412 Precondition Failed — the If-Match etag no longer matches. */
export class ConflictError extends Data.TaggedError('ConflictError')<{
  readonly calendarId: string;
  readonly eventId: string;
}> {}

export class NotFoundError extends Data.TaggedError('NotFoundError')<{
  readonly resource: string;
}> {}

/** Transport failure or 5xx. Retryable with backoff. */
export class ApiUnavailableError extends Data.TaggedError('ApiUnavailableError')<{
  readonly cause: string;
  readonly status?: number | undefined;
}> {}

/** Unexpected 4xx or undecodable payload — a bug, not a transient condition. */
export class GoogleApiError extends Data.TaggedError('GoogleApiError')<{
  readonly message: string;
  readonly status: number;
}> {}

/**
 * 403 naming an insufficient OAuth scope — the token was granted without a
 * scope this call needs. Refreshing cannot fix it; only re-consent can.
 */
export class InsufficientScopeError extends Data.TaggedError('InsufficientScopeError')<{
  readonly message: string;
}> {}
