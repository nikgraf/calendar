import { contrastingTextColor, type EventRecord, type PendingOp } from '@calendar/core';
import type {
  AccountRepoShape,
  CalendarRepoShape,
  EventRepoShape,
  PendingOpRepoShape,
  TaskRepoShape,
} from '@calendar/db';
import {
  type GoogleCalendarClientShape,
  type GoogleTasksClientShape,
  mapGcalCalendar,
  mapGcalEvent,
  hasGuests,
  mapGcalTask,
  toGcalAttendees,
  toGcalEventInput,
} from '@calendar/google';
import { Cause, Clock, Effect } from 'effect';

/**
 * Guests get emailed about any change to an event that has guests — the
 * decision was "always notify, never ask". Google ignores the flag when
 * nothing guest-relevant changed; rooms alone are nobody to notify, but
 * a guest-list edit notifies whoever was just removed.
 */
const sendUpdatesFor = (payload: EventRecord, attendeesChanged: boolean): 'all' | undefined =>
  hasGuests(payload) || attendeesChanged ? 'all' : undefined;

/**
 * The pending-op drain's per-op dispatch: one arm per op kind, mapping every
 * failure to 'done' (drop) or 'retry' (backoff). Split out of mutations.ts —
 * the queue-correctness rules live in docs/architecture.md.
 */
export interface ApplyOpDeps {
  readonly accountRepo: AccountRepoShape;
  readonly calendarRepo: CalendarRepoShape;
  readonly client: GoogleCalendarClientShape;
  readonly eventRepo: EventRepoShape;
  /** Broadcasts the 412 server-wins notice (CONFLICT_NOTICE_KEY). */
  readonly notifyConflict: Effect.Effect<void>;
  /** Broadcasts that a queued change was permanently rejected (DROPPED_NOTICE_KEY). */
  readonly notifyDropped: Effect.Effect<void>;
  readonly pendingOpRepo: PendingOpRepoShape;
  readonly taskRepo: TaskRepoShape;
  readonly tasksClient: GoogleTasksClientShape;
}

/** 'done' removes the op; a retry carries the reason the queue shows the user. */
export type ApplyOutcome = 'done' | { readonly retry: string };
const retry = (reason: string): ApplyOutcome => ({ retry: reason });

/** Tag + message (or cause) — a tagged error's own string form is just the tag. */
const describeFailure = (value: unknown): string => {
  if (value && typeof value === 'object') {
    const error = value as { _tag?: string; cause?: unknown; message?: string; name?: string };
    const tag = error._tag ?? error.name ?? 'Error';
    const detail = error.message || (error.cause === undefined ? '' : String(error.cause));
    return detail ? `${tag}: ${detail}` : tag;
  }
  return String(value);
};

const TASK_KINDS: ReadonlySet<PendingOp['kind']> = new Set([
  'completeTask',
  'createTask',
  'deleteTask',
  'updateTask',
]);

export const makeApplyOp = (
  deps: ApplyOpDeps,
): ((op: PendingOp) => Effect.Effect<ApplyOutcome>) => {
  const {
    accountRepo,
    calendarRepo,
    client,
    eventRepo,
    notifyConflict,
    notifyDropped,
    pendingOpRepo,
    taskRepo,
    tasksClient,
  } = deps;

  /**
   * The local row an abandoned op left `pending`: a dropped create takes
   * its optimistic row with it (deleteStale never collects pending rows,
   * so it would render forever as something Google never had); an
   * abandoned edit hands its row back to sync — pulls skip pending rows,
   * so without this the server's version could never land again.
   */
  const releaseRow = (op: PendingOp): Effect.Effect<void> => {
    switch (op.kind) {
      case 'create':
        return Effect.ignore(eventRepo.deleteEvent(op.accountId, op.calendarId, op.eventId));
      case 'createTask':
        return op.taskListId
          ? Effect.ignore(taskRepo.removeTask(op.accountId, op.taskListId, op.eventId))
          : Effect.void;
      case 'completeTask':
      case 'updateTask':
        return op.taskListId
          ? Effect.ignore(taskRepo.markSynced(op.accountId, op.taskListId, op.eventId))
          : Effect.void;
      case 'rsvp':
      case 'update':
        return Effect.ignore(eventRepo.markSynced(op.accountId, op.calendarId, op.eventId));
      default:
        return Effect.void;
    }
  };

  /** A rejection retrying cannot fix: say so, tell the UI, drop the op. */
  const drop = (op: PendingOp, reason: string): Effect.Effect<ApplyOutcome> =>
    Effect.logWarning('pending op dropped', { eventId: op.eventId, kind: op.kind, reason }).pipe(
      Effect.andThen(releaseRow(op)),
      Effect.andThen(Effect.ignore(notifyDropped)),
      Effect.as('done' as const),
    );

  return (op: PendingOp): Effect.Effect<ApplyOutcome> =>
    Effect.gen(function* () {
      // A task op queued behind its create while that create is still in
      // backoff: the create's id swap rewrites this op's eventId once it
      // lands. Patching the temp id now would 404 and the NotFound arm
      // would drop the local row — wait instead.
      if (op.kind !== 'createTask' && op.eventId.startsWith('local-')) {
        return retry('waiting for the create ahead of it to land');
      }
      switch (op.kind) {
        case 'calendarColor': {
          if (!op.colorHex) {
            return 'done' as const;
          }
          // The response echoes the final colors; upserting it self-heals
          // the case where a pull overwrote the optimistic value while
          // this op sat in backoff. upsertMany never touches is_visible.
          const entry = yield* client.patchCalendarListEntry({
            accountId: op.accountId,
            backgroundColor: op.colorHex,
            calendarId: op.calendarId,
            foregroundColor: contrastingTextColor(op.colorHex),
          });
          yield* calendarRepo.upsertMany([
            mapGcalCalendar(entry, {
              accountId: op.accountId,
              colorFromId: () => undefined,
              previousVisibility: undefined,
            }),
          ]);
          return 'done' as const;
        }
        case 'completeTask': {
          if (!op.taskListId || !op.taskStatus) {
            return 'done' as const;
          }
          // The response echoes the final task; upserting it self-heals a
          // backoff-window pull overwrite, and for repeating tasks Google
          // materializes the next occurrence server-side on completion —
          // the following poll picks that up.
          const response = yield* tasksClient.patchTask({
            accountId: op.accountId,
            changes: { status: op.taskStatus },
            taskId: op.eventId,
            taskListId: op.taskListId,
          });
          const synced = mapGcalTask(response, {
            accountId: op.accountId,
            taskListId: op.taskListId,
          });
          if (synced) {
            yield* taskRepo.upsertTasks([synced], yield* Clock.currentTimeMillis);
          }
          return 'done' as const;
        }
        case 'createTask': {
          if (!op.taskListId || !op.taskTitle) {
            return 'done' as const;
          }
          // A set dispatch stamp means an earlier attempt's insert may
          // have landed without us seeing the response (crash, dropped
          // connection). tasks.insert is not idempotent — ids are
          // server-assigned — so verify before inserting again: adopt an
          // exact field match updated since the stamp instead of creating
          // a duplicate. A false adopt needs an identical task created in
          // the same window elsewhere (and is benign); a miss is merely
          // the old behavior.
          if (op.dispatchedAt !== undefined) {
            const page = yield* tasksClient.listTasks({
              accountId: op.accountId,
              params: { updatedMin: new Date(op.dispatchedAt - 60_000).toISOString() },
              taskListId: op.taskListId,
            });
            const match = (page.items ?? []).filter(
              (candidate) =>
                !candidate.deleted &&
                candidate.title === op.taskTitle &&
                (candidate.due?.slice(0, 10) ?? undefined) === op.taskDue &&
                (candidate.notes ?? undefined) === op.taskNotes,
            );
            const adopted = match.length === 1 ? match[0] : undefined;
            if (adopted) {
              yield* pendingOpRepo.rewriteEventId(
                op.accountId,
                op.taskListId,
                op.eventId,
                adopted.id,
              );
              const adoptedRecord = mapGcalTask(adopted, {
                accountId: op.accountId,
                taskListId: op.taskListId,
              });
              if (adoptedRecord) {
                yield* taskRepo.removeTask(op.accountId, op.taskListId, op.eventId);
                yield* taskRepo.upsertTasks([adoptedRecord], yield* Clock.currentTimeMillis);
              }
              return 'done' as const;
            }
          }
          yield* pendingOpRepo.markDispatched(op.id, yield* Clock.currentTimeMillis);
          const inserted = yield* tasksClient.insertTask({
            accountId: op.accountId,
            task: {
              title: op.taskTitle,
              ...(op.taskDue ? { due: `${op.taskDue}T00:00:00.000Z` } : {}),
              ...(op.taskNotes ? { notes: op.taskNotes } : {}),
            },
            taskListId: op.taskListId,
          });
          // Swap the temp id for the server one everywhere it can appear:
          // the row itself and any ops queued behind this create
          // (processPendingOps drains oldest-first, so they run after).
          // Remove-then-upsert rather than UPDATE ... SET id: a concurrent
          // poll may already have upserted the server row, and a PK
          // conflict here would retry the op — re-running an insert the
          // Tasks API cannot deduplicate (ids are server-assigned, unlike
          // events). The same non-idempotency means a crash between the
          // insert response and op removal can duplicate a task; that
          // window is accepted, this one is not.
          yield* pendingOpRepo.rewriteEventId(op.accountId, op.taskListId, op.eventId, inserted.id);
          const insertedRecord = mapGcalTask(inserted, {
            accountId: op.accountId,
            taskListId: op.taskListId,
          });
          if (insertedRecord) {
            yield* taskRepo.removeTask(op.accountId, op.taskListId, op.eventId);
            yield* taskRepo.upsertTasks([insertedRecord], yield* Clock.currentTimeMillis);
          } else {
            // Unreachable in practice (a just-inserted task is never a
            // tombstone) — keep the row addressable under the server id.
            yield* taskRepo.replaceId(op.accountId, op.taskListId, op.eventId, inserted.id);
          }
          return 'done' as const;
        }
        case 'create': {
          if (!op.payload) {
            // Stored payload no longer decodes (a schema moved on): nothing
            // to send, and the user should know the edit is gone.
            return yield* drop(op, 'stored payload unreadable');
          }
          const response = yield* client.insertEvent({
            accountId: op.accountId,
            calendarId: op.calendarId,
            event: { ...toGcalEventInput(op.payload), attendees: toGcalAttendees(op.payload) },
            sendUpdates: sendUpdatesFor(op.payload, false),
          });
          const synced = mapGcalEvent(response, {
            accountId: op.accountId,
            calendarId: op.calendarId,
            defaultTimeZone: op.payload.startTimeZone ?? 'UTC',
            syncedAt: yield* Clock.currentTimeMillis,
          });
          if (synced) {
            yield* eventRepo.upsertMany([synced]);
          }
          return 'done' as const;
        }
        case 'delete': {
          yield* client.deleteEvent({
            accountId: op.accountId,
            baseEtag: op.baseEtag,
            calendarId: op.calendarId,
            eventId: op.eventId,
          });
          return 'done' as const;
        }
        case 'deleteTask': {
          if (!op.taskListId) {
            return 'done' as const;
          }
          yield* tasksClient.deleteTask({
            accountId: op.accountId,
            taskId: op.eventId,
            taskListId: op.taskListId,
          });
          return 'done' as const;
        }
        case 'rsvp': {
          if (!op.payload?.attendees) {
            return 'done' as const;
          }
          // Attendees-only patch, no If-Match: an RSVP should not lose to
          // unrelated content edits on the server copy.
          const response = yield* client.patchEvent({
            accountId: op.accountId,
            calendarId: op.calendarId,
            event: {
              attendees: op.payload.attendees.map((attendee) => ({
                email: attendee.email,
                responseStatus: attendee.responseStatus,
              })),
            },
            eventId: op.eventId,
          });
          const synced = mapGcalEvent(response, {
            accountId: op.accountId,
            calendarId: op.calendarId,
            defaultTimeZone: op.payload.startTimeZone ?? 'UTC',
            syncedAt: yield* Clock.currentTimeMillis,
          });
          if (synced) {
            yield* eventRepo.upsertMany([synced]);
          }
          return 'done' as const;
        }
        case 'update': {
          if (!op.payload) {
            // Stored payload no longer decodes (a schema moved on): nothing
            // to send, and the user should know the edit is gone.
            return yield* drop(op, 'stored payload unreadable');
          }
          // The guest list rides along only when this edit changed it:
          // Google replaces the whole array, and our copy may lack fields
          // we never model (optional, comment, additionalGuests).
          const response = yield* client.patchEvent({
            accountId: op.accountId,
            baseEtag: op.baseEtag,
            calendarId: op.calendarId,
            event: {
              ...toGcalEventInput(op.payload),
              ...(op.attendeesChanged ? { attendees: toGcalAttendees(op.payload) } : {}),
            },
            eventId: op.eventId,
            // Removed guests get their cancellation too: flagged edits
            // always notify, even when nobody is left.
            sendUpdates: sendUpdatesFor(op.payload, op.attendeesChanged === true),
          });
          const synced = mapGcalEvent(response, {
            accountId: op.accountId,
            calendarId: op.calendarId,
            defaultTimeZone: op.payload.startTimeZone ?? 'UTC',
            syncedAt: yield* Clock.currentTimeMillis,
          });
          if (synced) {
            yield* eventRepo.upsertMany([synced]);
          }
          return 'done' as const;
        }
        case 'updateTask': {
          if (!op.taskListId) {
            return 'done' as const;
          }
          const patched = yield* tasksClient.patchTask({
            accountId: op.accountId,
            changes: {
              ...(op.taskDue === undefined ? {} : { due: `${op.taskDue}T00:00:00.000Z` }),
              ...(op.taskNotes === undefined ? {} : { notes: op.taskNotes }),
              ...(op.taskTitle === undefined ? {} : { title: op.taskTitle }),
            },
            taskId: op.eventId,
            taskListId: op.taskListId,
          });
          const patchedRecord = mapGcalTask(patched, {
            accountId: op.accountId,
            taskListId: op.taskListId,
          });
          if (patchedRecord) {
            yield* taskRepo.upsertTasks([patchedRecord], yield* Clock.currentTimeMillis);
          }
          return 'done' as const;
        }
      }
    }).pipe(
      Effect.catchTags({
        // Server wins: drop the op, tell the UI the edit was overridden,
        // and let the next pull replace the local copy.
        ConflictError: () =>
          Effect.as(Effect.andThen(releaseRow(op), Effect.ignore(notifyConflict)), 'done' as const),
        GoogleApiError: (error) =>
          // 409 on insert = the idempotent create already landed. Other
          // 4xx are permanent (e.g. a rejected color patch) — retrying a
          // bad request forever would pin the queue, so the op is dropped
          // and the UI told; it used to vanish without a trace.
          error.status === 409
            ? Effect.succeed('done' as const)
            : (error.status >= 400 && error.status < 500 && error.status !== 429) ||
                // A 2xx whose body did not decode is a schema bug on our
                // side; retrying it forever at the 30-minute cap fixes
                // nothing. The response landed, so the next pull has it.
                (error.status >= 200 && error.status < 300)
              ? drop(op, `${error.status}: ${error.message}`)
              : Effect.succeed(retry(`${error.status}: ${error.message}`)),
        // The scope vanished after the op was queued (consent revoked, or
        // the enable flag was stale): this push can never succeed, so
        // retrying would pin the queue forever. Drop it; for a task op
        // also disable tasks for the account — the connect row reappears
        // in the UI. A calendar op cannot lose the tasks scope.
        InsufficientScopeError: (error) =>
          TASK_KINDS.has(op.kind)
            ? Effect.as(
                Effect.ignore(accountRepo.setTasksEnabled(op.accountId, false)),
                'done' as const,
              )
            : drop(op, `insufficient scope: ${error.message}`),
        NotFoundError: () =>
          Effect.gen(function* () {
            // Deleted remotely — drop the local copy too. (For deleteTask
            // this is simply "already gone".)
            const taskKinds = ['completeTask', 'createTask', 'deleteTask', 'updateTask'];
            if (taskKinds.includes(op.kind)) {
              if (op.taskListId) {
                yield* taskRepo.removeTask(op.accountId, op.taskListId, op.eventId);
              }
            } else {
              yield* eventRepo.deleteEvent(op.accountId, op.calendarId, op.eventId);
            }
            return 'done' as const;
          }),
        // Keep the op; flag the account so the UI offers a reconnect and
        // the queue drains after the user signs in again.
        ReauthRequiredError: () =>
          Effect.as(
            Effect.ignore(accountRepo.setStatus(op.accountId, 'reauth_required')),
            retry('signed out — reconnect the account'),
          ),
        SyncTokenExpiredError: () => Effect.succeed('done' as const),
      }),
      // Anything else (network, a defect): keep the op, record why.
      Effect.catchCause((cause) => {
        const reason = describeFailure(Cause.squash(cause));
        return Effect.as(
          Effect.logWarning('pending op failed, will retry', {
            eventId: op.eventId,
            kind: op.kind,
            reason,
          }),
          retry(reason),
        );
      }),
    );
};
