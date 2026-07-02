import { EventRecord, eventsScope, SyncState, Temporal, type Account } from '@calendar/core';
import { AccountRepo, CalendarRepo, EventRepo, SyncStateRepo } from '@calendar/db';
import {
  GoogleCalendarClient,
  mapGcalCalendar,
  mapGcalEvent,
  type GcalEvent,
  type GoogleRequestError,
} from '@calendar/google';
import { Clock, Context, Effect, Layer, Schedule, Semaphore } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';

const CALENDAR_LIST_SCOPE = 'calendarList';
const INITIAL_WINDOW_MS = 365 * 24 * 60 * 60 * 1000; // 12 months back
export const SYNC_INTERVAL = '90 seconds';

type SyncError = GoogleRequestError | SqlError;

/** Retries rate limits and transient availability failures with backoff. */
const withTransientRetry = <A, E extends { readonly _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.retry(effect, {
    schedule: Schedule.jittered(Schedule.exponential('1 second')),
    times: 5,
    while: (error) => error._tag === 'RateLimitedError' || error._tag === 'ApiUnavailableError',
  });

/**
 * Cancelled instances of recurring events arrive without times but with
 * originalStartTime; they must be stored as tombstones so expansion drops
 * the shadowed occurrence.
 */
const cancelledOverrideTombstone = (
  item: GcalEvent,
  context: { accountId: string; calendarId: string; syncedAt: number },
): EventRecord | null => {
  const original = item.originalStartTime;
  const originalStartUtc = original?.dateTime
    ? Temporal.Instant.from(original.dateTime).epochMilliseconds
    : original?.date
      ? Temporal.PlainDate.from(original.date).toZonedDateTime({ timeZone: 'UTC' }).toInstant()
          .epochMilliseconds
      : undefined;
  if (!item.recurringEventId || originalStartUtc === undefined) {
    return null;
  }
  return new EventRecord({
    accountId: context.accountId,
    calendarId: context.calendarId,
    endUtc: originalStartUtc,
    etag: item.etag ?? null,
    id: item.id,
    isAllDay: original?.date !== undefined,
    originalStartUtc,
    recurringEventId: item.recurringEventId,
    startUtc: originalStartUtc,
    status: 'cancelled',
    syncedAt: context.syncedAt,
    syncStatus: 'synced',
    title: '',
    updatedAt: context.syncedAt,
  });
};

export interface SyncEngineShape {
  /** Starts the polling scheduler (initial pass + every 90s) in the scope. */
  readonly start: () => Effect.Effect<void, never, never>;
  /** Full pass over every account; failures are logged, not thrown. */
  readonly syncAll: () => Effect.Effect<void>;
}

const make: Effect.Effect<
  SyncEngineShape,
  never,
  AccountRepo | CalendarRepo | EventRepo | GoogleCalendarClient | SyncStateRepo
> = Effect.gen(function* () {
  const client = yield* GoogleCalendarClient;
  const accountRepo = yield* AccountRepo;
  const calendarRepo = yield* CalendarRepo;
  const eventRepo = yield* EventRepo;
  const syncStateRepo = yield* SyncStateRepo;
  const gate = Semaphore.makeUnsafe(1);

  const syncCalendarList = (account: Account): Effect.Effect<void, SyncError> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const state = yield* syncStateRepo.get(account.id, CALENDAR_LIST_SCOPE);
      const colors = yield* withTransientRetry(client.getColors(account.id));
      const colorFromId = (colorId: string): string | undefined =>
        colors.calendar?.[colorId]?.background;

      const previous = yield* calendarRepo.list(account.id);
      const previousVisibility = new Map(
        previous.map((calendar) => [calendar.id, calendar.isVisible]),
      );

      const runPass = (
        syncToken: string | null,
      ): Effect.Effect<
        { deletedIds: Array<string>; keptIds: Array<string>; nextSyncToken: string | null },
        SyncError
      > =>
        Effect.gen(function* () {
          const keptIds: Array<string> = [];
          const deletedIds: Array<string> = [];
          let pageToken: string | undefined;
          let nextSyncToken: string | null = null;

          do {
            const page = yield* withTransientRetry(
              client.listCalendars({
                accountId: account.id,
                pageToken,
                syncToken: syncToken ?? undefined,
              }),
            );
            const upserts = [];
            for (const entry of page.items ?? []) {
              if (entry.deleted) {
                deletedIds.push(entry.id);
                continue;
              }
              keptIds.push(entry.id);
              upserts.push(
                mapGcalCalendar(entry, {
                  accountId: account.id,
                  colorFromId,
                  previousVisibility: previousVisibility.get(entry.id),
                }),
              );
            }
            yield* calendarRepo.upsertMany(upserts);
            pageToken = page.nextPageToken;
            nextSyncToken = page.nextSyncToken ?? nextSyncToken;
          } while (pageToken !== undefined);

          return { deletedIds, keptIds, nextSyncToken };
        });

      const result = yield* runPass(state?.syncToken ?? null).pipe(
        Effect.catchTag('SyncTokenExpiredError', () => runPass(null)),
      );

      if (state?.syncToken) {
        yield* calendarRepo.removeByIds(account.id, result.deletedIds);
      } else {
        // Full pass: anything not seen no longer exists upstream.
        yield* calendarRepo.removeMissing(account.id, result.keptIds);
      }

      yield* syncStateRepo.set(
        new SyncState({
          accountId: account.id,
          lastFullSyncAt: state?.syncToken ? (state.lastFullSyncAt ?? now) : now,
          lastSyncAt: now,
          scope: CALENDAR_LIST_SCOPE,
          status: 'idle',
          syncToken: result.nextSyncToken,
        }),
      );
    });

  const syncEvents = (account: Account, calendarId: string): Effect.Effect<void, SyncError> =>
    Effect.gen(function* () {
      const scope = eventsScope(calendarId);
      const state = yield* syncStateRepo.get(account.id, scope);
      const passStartedAt = yield* Clock.currentTimeMillis;

      const applyItems = (items: ReadonlyArray<GcalEvent>) =>
        Effect.gen(function* () {
          const context = {
            accountId: account.id,
            calendarId,
            defaultTimeZone: 'UTC',
            syncedAt: passStartedAt,
          };
          const upserts: Array<EventRecord> = [];
          const deletions: Array<string> = [];
          for (const item of items) {
            if (item.status === 'cancelled') {
              const tombstone = cancelledOverrideTombstone(item, context);
              if (tombstone) {
                upserts.push(tombstone);
              } else {
                deletions.push(item.id);
              }
              continue;
            }
            const record = mapGcalEvent(item, context);
            if (record) {
              upserts.push(record);
            }
          }
          yield* eventRepo.upsertMany(upserts);
          yield* Effect.forEach(
            deletions,
            (eventId) => eventRepo.deleteEvent(account.id, calendarId, eventId),
            { discard: true },
          );
        });

      const runPass = (syncToken: string | null): Effect.Effect<string | null, SyncError> =>
        Effect.gen(function* () {
          let pageToken: string | undefined;
          let nextSyncToken: string | null = null;
          const timeMin = new Date(passStartedAt - INITIAL_WINDOW_MS).toISOString();

          do {
            const page = yield* withTransientRetry(
              client.listEvents({
                accountId: account.id,
                calendarId,
                params: syncToken ? { pageToken, syncToken } : { pageToken, timeMin },
              }),
            );
            yield* applyItems(page.items ?? []);
            pageToken = page.nextPageToken;
            nextSyncToken = page.nextSyncToken ?? nextSyncToken;
          } while (pageToken !== undefined);

          return nextSyncToken;
        });

      const hadToken = state?.syncToken ?? null;
      let fullPass = hadToken === null;
      const nextSyncToken = yield* runPass(hadToken).pipe(
        Effect.catchTag('SyncTokenExpiredError', () => {
          fullPass = true;
          return runPass(null);
        }),
      );

      if (fullPass) {
        // Rows not touched by this pass no longer exist upstream (or fell
        // out of the window); local pending edits are preserved.
        yield* eventRepo.deleteStale(account.id, calendarId, passStartedAt);
      }

      yield* syncStateRepo.set(
        new SyncState({
          accountId: account.id,
          lastFullSyncAt: fullPass ? passStartedAt : (state?.lastFullSyncAt ?? null),
          lastSyncAt: passStartedAt,
          scope,
          status: 'idle',
          syncToken: nextSyncToken,
        }),
      );
    });

  const syncAccount = (account: Account): Effect.Effect<void, SyncError> =>
    Effect.gen(function* () {
      yield* syncCalendarList(account);
      const calendars = yield* calendarRepo.list(account.id);
      yield* Effect.forEach(calendars, (calendar) => syncEvents(account, calendar.id), {
        discard: true,
      });
    });

  const syncAll = (): Effect.Effect<void> =>
    gate
      .withPermits(1)(
        Effect.gen(function* () {
          const accounts = yield* accountRepo.list();
          for (const account of accounts) {
            if (account.status !== 'ok') {
              continue;
            }
            yield* syncAccount(account).pipe(
              Effect.catchTag('ReauthRequiredError', () =>
                accountRepo.setStatus(account.id, 'reauth_required'),
              ),
              Effect.catchCause((cause) =>
                Effect.logWarning('account sync failed', {
                  accountId: account.id,
                  cause: String(cause),
                }),
              ),
            );
          }
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning('sync pass failed', { cause: String(cause) }),
        ),
      );

  const start = (): Effect.Effect<void> =>
    Effect.asVoid(Effect.forkDetach(Effect.repeat(syncAll(), Schedule.spaced(SYNC_INTERVAL))));

  return { start, syncAll };
});

export class SyncEngine extends Context.Service<SyncEngine, SyncEngineShape>()('sync/SyncEngine') {
  static readonly layer: Layer.Layer<
    SyncEngine,
    never,
    AccountRepo | CalendarRepo | EventRepo | GoogleCalendarClient | SyncStateRepo
  > = Layer.effect(SyncEngine)(make);
}
