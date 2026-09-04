import { EventRecord, eventsScope, SyncState, Temporal, type Account } from '@calendar/core';
import { AccountRepo, CalendarRepo, EventRepo, SyncStateRepo, TaskRepo } from '@calendar/db';
import {
  GoogleCalendarClient,
  GoogleTasksClient,
  mapGcalCalendar,
  mapGcalEvent,
  mapGcalTask,
  mapGcalTaskList,
  type GcalEvent,
  type GoogleRequestError,
} from '@calendar/google';
import {
  mapReminder,
  mapReminderList,
  RemindersClient,
  type RemindersError,
} from '@calendar/reminders';
import { Clock, Context, Effect, Layer, Schedule, Semaphore } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { EventMutations } from './mutations.ts';

const CALENDAR_LIST_SCOPE = 'calendarList';
const tasksScope = (taskListId: string): string => `tasks:${taskListId}`;
const INITIAL_WINDOW_MS = 365 * 24 * 60 * 60 * 1000; // 12 months back
/** updatedMin has no tombstone guarantees forever — reconcile fully daily. */
const TASKS_FULL_PASS_INTERVAL_MS = 24 * 60 * 60 * 1000;
/**
 * Reminders mirror window: EventKit is local, so every pass is a full
 * replace of this window (rows outside it are not displayable anyway).
 */
const REMINDERS_PAST_DAYS = 90;
const REMINDERS_FUTURE_DAYS = 365;
/**
 * The watermark comes from the local clock but filters Google's `updated`
 * stamps: local time running ahead would open a blind window between the
 * two. Rewinding a minute closes it; re-reading the overlap is harmless
 * because upserts are idempotent.
 */
const WATERMARK_LAG_MS = 60_000;
export const SYNC_INTERVAL = '90 seconds';

type SyncError = GoogleRequestError | RemindersError | SqlError;

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
  | AccountRepo
  | CalendarRepo
  | EventMutations
  | EventRepo
  | GoogleCalendarClient
  | GoogleTasksClient
  | RemindersClient
  | SyncStateRepo
  | TaskRepo
> = Effect.gen(function* () {
  const mutations = yield* EventMutations;
  const client = yield* GoogleCalendarClient;
  const tasksClient = yield* GoogleTasksClient;
  const accountRepo = yield* AccountRepo;
  const calendarRepo = yield* CalendarRepo;
  const eventRepo = yield* EventRepo;
  const taskRepo = yield* TaskRepo;
  const remindersClient = yield* RemindersClient;
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

  const syncTaskLists = (account: Account): Effect.Effect<void, SyncError> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const keptIds: Array<string> = [];
      let pageToken: string | undefined;
      do {
        const page = yield* withTransientRetry(
          tasksClient.listTaskLists({ accountId: account.id, pageToken }),
        );
        const upserts = (page.items ?? []).map((entry) => {
          keptIds.push(entry.id);
          return mapGcalTaskList(entry, { accountId: account.id });
        });
        yield* taskRepo.upsertLists(upserts, now);
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined);
      // No syncToken/updatedMin on tasklists — every pass is full.
      yield* taskRepo.removeListsMissing(account.id, keptIds);
    });

  const syncTasks = (account: Account, taskListId: string): Effect.Effect<void, SyncError> =>
    Effect.gen(function* () {
      const scope = tasksScope(taskListId);
      const state = yield* syncStateRepo.get(account.id, scope);
      const passStartedAt = yield* Clock.currentTimeMillis;
      // The RFC 3339 updatedMin watermark lives in the sync_token column.
      const watermark = state?.syncToken ?? null;
      const fullPass =
        watermark === null ||
        (state?.lastFullSyncAt ?? 0) < passStartedAt - TASKS_FULL_PASS_INTERVAL_MS;

      let pageToken: string | undefined;
      do {
        const page = yield* withTransientRetry(
          tasksClient.listTasks({
            accountId: account.id,
            params: {
              pageToken,
              updatedMin: fullPass ? undefined : (watermark ?? undefined),
            },
            taskListId,
          }),
        );
        const upserts = [];
        const deletions: Array<string> = [];
        for (const item of page.items ?? []) {
          const record = mapGcalTask(item, { accountId: account.id, taskListId });
          if (record) {
            upserts.push(record);
          } else {
            deletions.push(item.id);
          }
        }
        yield* taskRepo.upsertTasks(upserts, passStartedAt);
        yield* taskRepo.removeTasksByIds(account.id, taskListId, deletions);
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined);

      if (fullPass) {
        // Rows not touched by this pass no longer exist upstream; pending
        // local completions were just re-upserted, so nothing is lost.
        yield* taskRepo.deleteStale(account.id, taskListId, passStartedAt);
      }

      yield* syncStateRepo.set(
        new SyncState({
          accountId: account.id,
          lastFullSyncAt: fullPass ? passStartedAt : (state?.lastFullSyncAt ?? null),
          lastSyncAt: passStartedAt,
          scope,
          status: 'idle',
          // Captured before the first request so nothing updated mid-pass
          // slips between watermarks; rewound to absorb clock skew.
          syncToken: new Date(passStartedAt - WATERMARK_LAG_MS).toISOString(),
        }),
      );
    });

  const syncAccountTasks = (account: Account): Effect.Effect<void, SyncError> =>
    Effect.gen(function* () {
      yield* syncTaskLists(account);
      const lists = yield* taskRepo.listLists(account.id);
      yield* Effect.forEach(lists, (list) => syncTasks(account, list.id), { discard: true });
    }).pipe(
      // The token was granted without the tasks scope after all (stale
      // flag, consent revoked): disable rather than fail the account.
      Effect.catchTag('InsufficientScopeError', () =>
        Effect.orDie(accountRepo.setTasksEnabled(account.id, false)),
      ),
    );

  /**
   * The Apple account: lists + a windowed full replace of reminders. Access
   * can be revoked at any time in System Settings, so the status check
   * doubles as the account's health: no access flags it, access regained
   * (even without pressing Connect again) heals it.
   */
  const syncReminders = (account: Account): Effect.Effect<void, SyncError> =>
    Effect.gen(function* () {
      const authorization = yield* remindersClient
        .status()
        .pipe(Effect.orElseSucceed(() => 'unavailable' as const));
      if (authorization === 'unavailable') {
        // No bridge (helper missing/crashed, old dev client, e2e's
        // CALENDAR_REMINDERS=off): nothing to say about the TCC grant, so
        // leave the account alone rather than send the user to System
        // Settings for a problem that is not there.
        yield* Effect.logDebug('reminders bridge unavailable; skipping pass');
        return;
      }
      if (authorization !== 'fullAccess') {
        if (account.status === 'ok') {
          yield* accountRepo.setStatus(account.id, 'reauth_required');
        }
        return;
      }
      if (account.status !== 'ok') {
        yield* accountRepo.setStatus(account.id, 'ok');
      }
      // Stamped before the fetch: every row this pass writes carries it,
      // and so does anything a concurrent mutation mirrors meanwhile —
      // only rows older than the pass are candidates for removal.
      const passStartedAt = yield* Clock.currentTimeMillis;
      const lists = yield* remindersClient.listLists();
      yield* taskRepo.upsertLists(
        lists.map((list) => mapReminderList(list, account.id)),
        passStartedAt,
      );
      yield* taskRepo.removeListsMissing(
        account.id,
        lists.map((list) => list.id),
      );
      const today = Temporal.Now.plainDateISO();
      const windowStart = today.subtract({ days: REMINDERS_PAST_DAYS }).toString();
      const windowEnd = today.add({ days: REMINDERS_FUTURE_DAYS }).toString();
      const reminders = yield* remindersClient.list({ endDate: windowEnd, startDate: windowStart });
      yield* taskRepo.upsertTasks(
        reminders.map((reminder) => mapReminder(reminder, account.id)),
        passStartedAt,
      );
      // Full replace *within the fetched window*: a mirrored reminder due
      // outside it (created here, far in the future) is simply not this
      // pass's business and stays until a pass covers its day.
      yield* Effect.forEach(
        lists,
        (list) =>
          taskRepo.removeMirrorStale({
            accountId: account.id,
            keepIds: reminders
              .filter((reminder) => reminder.listId === list.id)
              .map((reminder) => reminder.id),
            listId: list.id,
            syncedBefore: passStartedAt,
            windowEnd,
            windowStart,
          }),
        { discard: true },
      );
    }).pipe(
      Effect.catchTag('RemindersAccessError', () =>
        Effect.orDie(accountRepo.setStatus(account.id, 'reauth_required')),
      ),
    );

  const syncAccount = (account: Account): Effect.Effect<void, SyncError> =>
    Effect.gen(function* () {
      yield* syncCalendarList(account);
      const calendars = yield* calendarRepo.list(account.id);
      yield* Effect.forEach(calendars, (calendar) => syncEvents(account, calendar.id), {
        discard: true,
      });
      if (account.tasksEnabled) {
        yield* syncAccountTasks(account);
      }
    });

  const syncAll = (): Effect.Effect<void> =>
    gate
      .withPermits(1)(
        Effect.gen(function* () {
          // Push local edits first to minimise conflicts with the pull below.
          yield* mutations.processPendingOps();
          const accounts = yield* accountRepo.list();
          for (const account of accounts) {
            if (account.provider === 'apple') {
              // Always attempted: the status check is what heals a
              // revoked-then-restored grant, so a flagged account must
              // not be skipped.
              yield* syncReminders(account).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning('reminders sync failed', { cause: String(cause) }),
                ),
              );
              continue;
            }
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
    | AccountRepo
    | CalendarRepo
    | EventMutations
    | EventRepo
    | GoogleCalendarClient
    | GoogleTasksClient
    | RemindersClient
    | SyncStateRepo
    | TaskRepo
  > = Layer.effect(SyncEngine)(make);
}
