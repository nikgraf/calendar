import { type EventRecord } from '@calendar/core';
import { Context, Effect, Layer } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { EVENTS_KEY, eventsKey } from './keys.ts';
import { eventFromRow, eventToRow, type EventRow } from './rows.ts';
import { accountGuard } from './repoShared.ts';

export interface EventWindow {
  /** Recurring masters possibly intersecting the range. */
  readonly masters: ReadonlyArray<EventRecord>;
  /** Override instances of those masters (any range) keyed later by master. */
  readonly overrides: ReadonlyArray<EventRecord>;
  /** Concrete events overlapping the range (includes in-range overrides). */
  readonly singles: ReadonlyArray<EventRecord>;
}

export interface EventRepoShape {
  readonly deleteEvent: (
    accountId: string,
    calendarId: string,
    eventId: string,
  ) => Effect.Effect<void, SqlError>;
  /** Deletes synced rows of a calendar not touched at/after syncedAt. */
  readonly deleteStale: (
    accountId: string,
    calendarId: string,
    syncedAt: number,
  ) => Effect.Effect<void, SqlError>;
  readonly getById: (
    accountId: string,
    calendarId: string,
    eventId: string,
  ) => Effect.Effect<EventRecord | null, SqlError>;
  /** Window of visible-calendar events for range rendering. */
  readonly getWindow: (
    rangeStartUtc: number,
    rangeEndUtc: number,
  ) => Effect.Effect<EventWindow, SqlError>;
  /** Exception rows belonging to a recurring master. */
  readonly listOverrides: (
    accountId: string,
    calendarId: string,
    masterId: string,
  ) => Effect.Effect<ReadonlyArray<EventRecord>, SqlError>;
  /** Hands a row back to sync after its queued edit was abandoned. */
  readonly markSynced: (
    accountId: string,
    calendarId: string,
    eventId: string,
  ) => Effect.Effect<void, SqlError>;
  /**
   * `mode: 'pull'` (sync pages) leaves rows with a queued local edit
   * (`sync_status = 'pending'`) untouched; the default ('ack', push
   * responses and local writes) overwrites.
   */
  readonly upsertMany: (
    events: ReadonlyArray<EventRecord>,
    options?: { readonly mode?: 'ack' | 'pull' },
  ) => Effect.Effect<void, SqlError>;
}

const makeEventRepo: Effect.Effect<EventRepoShape, never, Reactivity | SqlClient> = Effect.gen(
  function* () {
    const sql = yield* SqlClient;
    const reactivity = yield* Reactivity;

    const upsertOne = (event: EventRecord, mode: 'ack' | 'pull') => {
      const row = eventToRow(event);
      const guard = mode === 'pull' ? sql`WHERE events.sync_status != 'pending'` : sql``;
      return sql`
      INSERT INTO events (account_id, calendar_id, id, etag, status, title, location,
                          description, is_all_day, start_utc, end_utc, start_date,
                          end_date, start_time_zone, recurrence, recurring_event_id,
                          original_start_utc, attendees, organizer_email, sync_status,
                          updated_at, synced_at)
      SELECT ${row.account_id}, ${row.calendar_id}, ${row.id}, ${row.etag},
             ${row.status}, ${row.title}, ${row.location}, ${row.description},
             ${row.is_all_day}, ${row.start_utc}, ${row.end_utc}, ${row.start_date},
             ${row.end_date}, ${row.start_time_zone}, ${row.recurrence},
             ${row.recurring_event_id}, ${row.original_start_utc}, ${row.attendees},
             ${row.organizer_email}, ${row.sync_status}, ${row.updated_at},
             ${row.synced_at}
      ${accountGuard(sql, row.account_id)}
      ON CONFLICT (account_id, calendar_id, id) DO UPDATE SET
        etag = excluded.etag,
        status = excluded.status,
        title = excluded.title,
        location = excluded.location,
        description = excluded.description,
        is_all_day = excluded.is_all_day,
        start_utc = excluded.start_utc,
        end_utc = excluded.end_utc,
        start_date = excluded.start_date,
        end_date = excluded.end_date,
        start_time_zone = excluded.start_time_zone,
        recurrence = excluded.recurrence,
        recurring_event_id = excluded.recurring_event_id,
        original_start_utc = excluded.original_start_utc,
        attendees = excluded.attendees,
        organizer_email = excluded.organizer_email,
        sync_status = excluded.sync_status,
        updated_at = excluded.updated_at,
        synced_at = excluded.synced_at
      ${guard}
    `;
    };

    return {
      deleteEvent: (accountId, calendarId, eventId) =>
        reactivity.mutation(
          [EVENTS_KEY, eventsKey(calendarId)],
          Effect.asVoid(
            sql`DELETE FROM events WHERE account_id = ${accountId}
              AND calendar_id = ${calendarId} AND id = ${eventId}`,
          ),
        ),
      deleteStale: (accountId, calendarId, syncedAt) =>
        reactivity.mutation(
          [EVENTS_KEY, eventsKey(calendarId)],
          Effect.asVoid(
            sql`DELETE FROM events WHERE account_id = ${accountId}
              AND calendar_id = ${calendarId} AND sync_status = 'synced'
              AND synced_at < ${syncedAt}`,
          ),
        ),
      getById: (accountId, calendarId, eventId) =>
        Effect.map(
          sql<EventRow>`SELECT * FROM events WHERE account_id = ${accountId}
            AND calendar_id = ${calendarId} AND id = ${eventId}`,
          (rows) => (rows[0] ? eventFromRow(rows[0]) : null),
        ),
      getWindow: (rangeStartUtc, rangeEndUtc) =>
        Effect.gen(function* () {
          const singles = yield* sql<EventRow>`
          SELECT e.* FROM events e
          JOIN calendars c ON c.account_id = e.account_id AND c.id = e.calendar_id
          WHERE c.is_visible = 1 AND e.recurrence IS NULL
          AND e.start_utc < ${rangeEndUtc} AND e.end_utc > ${rangeStartUtc}
          AND e.status != 'cancelled'`;

          const masters = yield* sql<EventRow>`
          SELECT e.* FROM events e
          JOIN calendars c ON c.account_id = e.account_id AND c.id = e.calendar_id
          WHERE c.is_visible = 1 AND e.recurrence IS NOT NULL
          AND e.start_utc < ${rangeEndUtc}
          AND e.status != 'cancelled'`;

          const masterIds = masters.map((row) => row.id);
          // An override shadows an occurrence of the master it belongs
          // to — the one in its own account and calendar. Event ids are
          // Google-global, so two accounts on a shared calendar hold
          // masters with the same id: an unscoped `IN` handed account
          // A's exception rows to account B's master and hid B's
          // occurrences. Same join as the other two queries keeps
          // hidden calendars out.
          const overrides =
            masterIds.length === 0
              ? []
              : yield* sql<EventRow>`
                SELECT e.* FROM events e
                JOIN events m ON m.account_id = e.account_id
                  AND m.calendar_id = e.calendar_id AND m.id = e.recurring_event_id
                JOIN calendars c ON c.account_id = e.account_id AND c.id = e.calendar_id
                WHERE c.is_visible = 1 AND m.recurrence IS NOT NULL
                AND e.recurring_event_id IN ${sql.in(masterIds)}`;

          return {
            masters: masters.map(eventFromRow),
            overrides: overrides.map(eventFromRow),
            singles: singles.map(eventFromRow),
          };
        }),
      listOverrides: (accountId, calendarId, masterId) =>
        Effect.map(
          sql<EventRow>`SELECT * FROM events WHERE account_id = ${accountId}
            AND calendar_id = ${calendarId} AND recurring_event_id = ${masterId}`,
          (rows) => rows.map(eventFromRow),
        ),
      markSynced: (accountId, calendarId, eventId) =>
        reactivity.mutation(
          [EVENTS_KEY, eventsKey(calendarId)],
          Effect.asVoid(
            sql`UPDATE events SET sync_status = 'synced' WHERE account_id = ${accountId}
              AND calendar_id = ${calendarId} AND id = ${eventId}`,
          ),
        ),
      upsertMany: (events, options) => {
        const keys = [EVENTS_KEY, ...new Set(events.map((event) => eventsKey(event.calendarId)))];
        const mode = options?.mode ?? 'ack';
        return reactivity.mutation(
          keys,
          Effect.forEach(events, (event) => upsertOne(event, mode), { discard: true }),
        );
      },
    };
  },
);

export class EventRepo extends Context.Service<EventRepo, EventRepoShape>()('db/EventRepo') {
  static readonly layer: Layer.Layer<EventRepo, never, Reactivity | SqlClient> =
    Layer.effect(EventRepo)(makeEventRepo);
}
