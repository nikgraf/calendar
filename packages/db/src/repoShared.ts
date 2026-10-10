import {
  CarriedText,
  type EventRecord,
  EventRecord as EventRecordSchema,
  type TaskRecord,
  TaskRecord as TaskRecordSchema,
} from '@calendar/core';
import { Schema } from 'effect';
import { SqlClient } from 'effect/sql/SqlClient';

/** PendingOp payloads are stored as encoded EventRecord JSON. */
export const eventPayloadJson = (event: EventRecord): unknown =>
  Schema.encodeSync(EventRecordSchema)(event);

const eventListSchema = Schema.Array(EventRecordSchema);

export const eventListJson = (events: ReadonlyArray<EventRecord>): unknown =>
  Schema.encodeSync(eventListSchema)(events);

export const taskPayloadJson = (task: TaskRecord): unknown =>
  Schema.encodeSync(TaskRecordSchema)(task);

export const carriedTextJson = (carried: CarriedText): unknown =>
  Schema.encodeSync(CarriedText)(carried);

/**
 * The WHERE clause of every mirror INSERT: a row is written only while its
 * account exists. A sync pass can finish after the user removed the
 * account (the fetch was in flight); without this its upserts would
 * recreate lists, rows and sync state that no later pass cleans up. The
 * SELECT form is what lets an INSERT carry a WHERE (and SQLite needs a
 * WHERE there anyway to parse the ON CONFLICT clause that follows).
 */
export const accountGuard = (sql: SqlClient, accountId: string) =>
  sql`WHERE EXISTS (SELECT 1 FROM accounts WHERE id = ${accountId})`;
