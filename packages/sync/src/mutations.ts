import {
  applyWallClockDelta,
  Attendee,
  contrastingTextColor,
  type EventDraft,
  EventRecord,
  googleInstanceId,
  normalizeHexColor,
  PendingOp,
  type RecurringScope,
  remainingRecurrence,
  type RsvpResponse,
  TaskRecord,
  truncateRecurrence,
} from '@calendar/core';
import { AccountRepo, CalendarRepo, EventRepo, PendingOpRepo, TaskRepo } from '@calendar/db';
import { CONFLICT_NOTICE_KEY } from '@calendar/db/keys';
import {
  generateEventId,
  GoogleCalendarClient,
  GoogleTasksClient,
  mapGcalCalendar,
  mapGcalEvent,
  mapGcalTask,
  toGcalEventInput,
} from '@calendar/google';
import { Clock, Context, Data, Effect, Layer, Semaphore } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import type { SqlError } from 'effect/unstable/sql/SqlError';

export class EventNotFoundError extends Data.TaggedError('EventNotFoundError')<{
  readonly eventId: string;
}> {}

/**
 * Raised when a plain edit targets a recurring master/override (those go
 * through updateRecurring/deleteRecurring) or a recurring edit targets a
 * non-recurring event.
 */
export class RecurringEditUnsupportedError extends Data.TaggedError(
  'RecurringEditUnsupportedError',
)<{ readonly eventId: string }> {}

/** The signed-in account is not on the event's guest list. */
export class NotAttendeeError extends Data.TaggedError('NotAttendeeError')<{
  readonly eventId: string;
}> {}

export class InvalidColorError extends Data.TaggedError('InvalidColorError')<{
  readonly colorHex: string;
}> {}

export class TaskNotFoundError extends Data.TaggedError('TaskNotFoundError')<{
  readonly taskId: string;
}> {}

export class TaskListNotFoundError extends Data.TaggedError('TaskListNotFoundError')<{
  readonly taskListId: string;
}> {}

/** Sentinel eventId keying calendar-color ops for coalescing. */
export const CALENDAR_COLOR_EVENT_ID = '__calendar_color__';

export interface UpdateEventParams {
  readonly accountId: string;
  readonly calendarId: string;
  readonly changes: {
    readonly description?: string | undefined;
    readonly endDate?: string | undefined;
    readonly endUtc?: number | undefined;
    readonly isAllDay?: boolean | undefined;
    readonly location?: string | undefined;
    readonly startDate?: string | undefined;
    readonly startUtc?: number | undefined;
    readonly title?: string | undefined;
  };
  readonly eventId: string;
}

/** Identifies one occurrence of a recurring series and the edit's reach. */
export interface RecurringTargetParams {
  readonly accountId: string;
  readonly calendarId: string;
  readonly masterId: string;
  readonly originalStartUtc: number;
  readonly scope: RecurringScope;
}

export interface UpdateRecurringParams extends RecurringTargetParams {
  readonly changes: UpdateEventParams['changes'];
}

type RecurringEditError = EventNotFoundError | RecurringEditUnsupportedError | SqlError;

export interface EventMutationsShape {
  /** Toggles a task's completion locally and writes it back to Google. */
  readonly completeTask: (params: {
    readonly accountId: string;
    readonly status: TaskRecord['status'];
    readonly taskId: string;
    readonly taskListId: string;
  }) => Effect.Effect<void, SqlError | TaskNotFoundError>;
  readonly createEvent: (draft: EventDraft) => Effect.Effect<EventRecord, SqlError>;
  /** Creates a task optimistically under a temp id; the push swaps ids. */
  readonly createTask: (params: {
    readonly accountId: string;
    readonly dueDate: string;
    readonly notes?: string | undefined;
    readonly taskListId: string;
    readonly title: string;
  }) => Effect.Effect<TaskRecord, SqlError | TaskListNotFoundError>;
  readonly deleteEvent: (params: {
    readonly accountId: string;
    readonly calendarId: string;
    readonly eventId: string;
  }) => Effect.Effect<void, RecurringEditError>;
  readonly deleteRecurring: (
    params: RecurringTargetParams,
  ) => Effect.Effect<void, RecurringEditError>;
  readonly deleteTask: (params: {
    readonly accountId: string;
    readonly taskId: string;
    readonly taskListId: string;
  }) => Effect.Effect<void, SqlError>;
  /** Drains due pending ops (serialized); safe to call concurrently. */
  readonly processPendingOps: () => Effect.Effect<void>;
  /** Updates the caller's own attendee responseStatus (series-wide). */
  readonly respondToEvent: (params: {
    readonly accountId: string;
    readonly calendarId: string;
    readonly eventId: string;
    readonly response: RsvpResponse;
  }) => Effect.Effect<void, EventNotFoundError | NotAttendeeError | SqlError>;
  /** Recolors a calendar locally and writes it back to Google. */
  readonly setCalendarColor: (params: {
    readonly accountId: string;
    readonly calendarId: string;
    readonly colorHex: string;
  }) => Effect.Effect<void, InvalidColorError | SqlError>;
  readonly updateEvent: (params: UpdateEventParams) => Effect.Effect<void, RecurringEditError>;
  readonly updateRecurring: (
    params: UpdateRecurringParams,
  ) => Effect.Effect<void, RecurringEditError>;
  /** Edits title/notes/due optimistically and patches Google. */
  readonly updateTask: (params: {
    readonly accountId: string;
    readonly changes: {
      readonly dueDate?: string | undefined;
      readonly notes?: string | undefined;
      readonly title?: string | undefined;
    };
    readonly taskId: string;
    readonly taskListId: string;
  }) => Effect.Effect<void, SqlError>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDate = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

/** Backoff for transient op failures: 30s · 2^attempts, capped at 30min. */
export const retryDelayMs = (attempts: number): number =>
  Math.min(30_000 * 2 ** attempts, 30 * 60 * 1000);

const make: Effect.Effect<
  EventMutationsShape,
  never,
  | AccountRepo
  | CalendarRepo
  | EventRepo
  | GoogleCalendarClient
  | GoogleTasksClient
  | PendingOpRepo
  | Reactivity
  | TaskRepo
> = Effect.gen(function* () {
  const reactivity = yield* Reactivity;
  const accountRepo = yield* AccountRepo;
  const calendarRepo = yield* CalendarRepo;
  const eventRepo = yield* EventRepo;
  const pendingOpRepo = yield* PendingOpRepo;
  const client = yield* GoogleCalendarClient;
  const tasksClient = yield* GoogleTasksClient;
  const taskRepo = yield* TaskRepo;
  const gate = Semaphore.makeUnsafe(1);

  const opsForEvent = (calendarId: string, eventId: string) =>
    Effect.map(pendingOpRepo.listAll(), (ops) =>
      ops.filter((op) => op.calendarId === calendarId && op.eventId === eventId),
    );

  const enqueueAndKick = (op: PendingOp) =>
    Effect.gen(function* () {
      yield* pendingOpRepo.enqueue(op);
      yield* Effect.forkDetach(processPendingOps());
    });

  const loadMaster = (accountId: string, calendarId: string, masterId: string) =>
    Effect.gen(function* () {
      const master = yield* eventRepo.getById(accountId, calendarId, masterId);
      if (!master) {
        return yield* Effect.fail(new EventNotFoundError({ eventId: masterId }));
      }
      const recurrence = master.recurrence;
      if (!recurrence || recurrence.length === 0) {
        return yield* Effect.fail(new RecurringEditUnsupportedError({ eventId: masterId }));
      }
      return { master, recurrence };
    });

  /** The occurrence as it would render, keyed by its Google instance id. */
  const projectInstance = (master: EventRecord, originalStartUtc: number, now: number) => {
    const durationDays =
      master.isAllDay && master.startDate && master.endDate
        ? Math.round((Date.parse(master.endDate) - Date.parse(master.startDate)) / DAY_MS)
        : 0;
    return new EventRecord({
      ...master,
      endDate: master.isAllDay ? isoDate(originalStartUtc + durationDays * DAY_MS) : undefined,
      endUtc:
        originalStartUtc +
        (master.isAllDay ? durationDays * DAY_MS : master.endUtc - master.startUtc),
      etag: null,
      id: googleInstanceId(master.id, originalStartUtc, master.isAllDay),
      originalStartUtc,
      recurrence: undefined,
      recurringEventId: master.id,
      startDate: master.isAllDay ? isoDate(originalStartUtc) : undefined,
      startUtc: originalStartUtc,
      syncedAt: 0,
      syncStatus: 'pending',
      updatedAt: now,
    });
  };

  /** Drops override rows at/after the split and cancels them remotely. */
  const dropOverridesFrom = (
    accountId: string,
    calendarId: string,
    masterId: string,
    fromOriginalStartUtc: number,
    now: number,
  ) =>
    Effect.gen(function* () {
      const overrides = yield* eventRepo.listOverrides(accountId, calendarId, masterId);
      for (const override of overrides) {
        if ((override.originalStartUtc ?? override.startUtc) < fromOriginalStartUtc) {
          continue;
        }
        yield* pendingOpRepo.removeForEvent(calendarId, override.id);
        yield* eventRepo.deleteEvent(accountId, calendarId, override.id);
        yield* enqueueAndKick(
          new PendingOp({
            accountId,
            attempts: 0,
            baseEtag: override.etag ?? undefined,
            calendarId,
            createdAt: now,
            eventId: override.id,
            id: generateEventId(),
            kind: 'delete',
            nextAttemptAt: 0,
          }),
        );
      }
    });

  const applyOp = (op: PendingOp): Effect.Effect<'done' | 'retry', never> =>
    Effect.gen(function* () {
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
            return 'done' as const;
          }
          const response = yield* client.insertEvent({
            accountId: op.accountId,
            calendarId: op.calendarId,
            event: toGcalEventInput(op.payload),
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
            return 'done' as const;
          }
          const response = yield* client.patchEvent({
            accountId: op.accountId,
            baseEtag: op.baseEtag,
            calendarId: op.calendarId,
            event: toGcalEventInput(op.payload),
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
        // Server wins: drop the op, tell the UI the edit was overridden.
        ConflictError: () =>
          Effect.as(Effect.ignore(reactivity.invalidate([CONFLICT_NOTICE_KEY])), 'done' as const),
        GoogleApiError: (error) =>
          // 409 on insert = the idempotent create already landed. Other
          // 4xx are permanent (e.g. a rejected color patch) — retrying a
          // bad request forever would pin the queue.
          error.status === 409 ||
          (error.status >= 400 && error.status < 500 && error.status !== 429)
            ? Effect.succeed('done' as const)
            : Effect.succeed('retry' as const),
        // The scope vanished after the op was queued (consent revoked, or
        // the enable flag was stale): this push can never succeed, so
        // retrying would pin the queue forever. Drop it and disable tasks
        // for the account — the connect row reappears in the UI.
        InsufficientScopeError: () =>
          Effect.as(
            Effect.ignore(accountRepo.setTasksEnabled(op.accountId, false)),
            'done' as const,
          ),
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
            'retry' as const,
          ),
        SyncTokenExpiredError: () => Effect.succeed('done' as const),
      }),
      Effect.catchCause(() => Effect.succeed('retry' as const)),
    );

  const processPendingOps = (): Effect.Effect<void> =>
    gate
      .withPermits(1)(
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis;
          const due = yield* pendingOpRepo.listDue(now);
          for (const queuedOp of due) {
            // Re-read: an earlier op in this drain may have rewritten this
            // one (createTask swaps a temp task id into queued followers) —
            // or the user may have discarded it, in which case skip rather
            // than resurrect the stale snapshot.
            const op = yield* pendingOpRepo.getById(queuedOp.id);
            if (!op) {
              continue;
            }
            const outcome = yield* applyOp(op);
            if (outcome === 'done') {
              yield* pendingOpRepo.remove(op.id);
            } else {
              yield* pendingOpRepo.markFailed(
                op.id,
                op.attempts + 1,
                now + retryDelayMs(op.attempts),
                'transient failure',
              );
            }
          }
        }),
      )
      .pipe(Effect.catchCause(() => Effect.void));

  const shape: EventMutationsShape = {
    completeTask: ({ accountId, status, taskId, taskListId }) =>
      Effect.gen(function* () {
        const window = yield* taskRepo.listLists(accountId);
        if (!window.some((list) => list.id === taskListId)) {
          return yield* Effect.fail(new TaskNotFoundError({ taskId }));
        }
        const now = yield* Clock.currentTimeMillis;
        yield* taskRepo.setStatus({
          accountId,
          completedAt: status === 'completed' ? now : undefined,
          listId: taskListId,
          status,
          taskId,
        });
        // Only the latest toggle needs to reach Google.
        const queued = yield* opsForEvent(taskListId, taskId);
        for (const op of queued) {
          if (op.accountId === accountId && op.kind === 'completeTask') {
            yield* pendingOpRepo.remove(op.id);
          }
        }
        yield* enqueueAndKick(
          new PendingOp({
            accountId,
            attempts: 0,
            // Op identity reuses the event columns as opaque ids, like
            // calendarColor's sentinel does.
            calendarId: taskListId,
            createdAt: now,
            eventId: taskId,
            id: generateEventId(),
            kind: 'completeTask',
            nextAttemptAt: 0,
            taskListId,
            taskStatus: status,
          }),
        );
      }),
    createEvent: (draft) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const record = new EventRecord({
          accountId: draft.accountId,
          calendarId: draft.calendarId,
          description: draft.description,
          endDate: draft.endDate,
          endUtc: draft.endUtc,
          etag: null,
          id: generateEventId(),
          isAllDay: draft.isAllDay,
          location: draft.location,
          recurrence: draft.recurrence,
          startDate: draft.startDate,
          startTimeZone: draft.startTimeZone,
          startUtc: draft.startUtc,
          status: 'confirmed',
          syncedAt: 0,
          syncStatus: 'pending',
          title: draft.title,
          updatedAt: now,
        });
        yield* eventRepo.upsertMany([record]);
        yield* enqueueAndKick(
          new PendingOp({
            accountId: draft.accountId,
            attempts: 0,
            calendarId: draft.calendarId,
            createdAt: now,
            eventId: record.id,
            id: generateEventId(),
            kind: 'create',
            nextAttemptAt: 0,
            payload: record,
          }),
        );
        return record;
      }),

    createTask: ({ accountId, dueDate, notes, taskListId, title }) =>
      Effect.gen(function* () {
        const lists = yield* taskRepo.listLists(accountId);
        if (!lists.some((list) => list.id === taskListId)) {
          return yield* Effect.fail(new TaskListNotFoundError({ taskListId }));
        }
        const now = yield* Clock.currentTimeMillis;
        // The Tasks API assigns ids server-side (no client ids like
        // events): a temp id keeps the optimistic row addressable until
        // the push swaps it.
        const tempId = `local-${generateEventId()}`;
        const record = new TaskRecord({
          accountId,
          dueDate,
          id: tempId,
          listId: taskListId,
          ...(notes === undefined ? {} : { notes }),
          status: 'needsAction',
          title,
          updatedAt: now,
        });
        yield* taskRepo.insertLocal(record);
        yield* enqueueAndKick(
          new PendingOp({
            accountId,
            attempts: 0,
            calendarId: taskListId,
            createdAt: now,
            eventId: tempId,
            id: generateEventId(),
            kind: 'createTask',
            nextAttemptAt: 0,
            ...(dueDate === undefined ? {} : { taskDue: dueDate }),
            taskListId,
            ...(notes === undefined ? {} : { taskNotes: notes }),
            taskTitle: title,
          }),
        );
        return record;
      }),

    deleteEvent: ({ accountId, calendarId, eventId }) =>
      Effect.gen(function* () {
        const existing = yield* eventRepo.getById(accountId, calendarId, eventId);
        if (!existing) {
          return yield* Effect.fail(new EventNotFoundError({ eventId }));
        }
        if (existing.recurringEventId || existing.recurrence) {
          return yield* Effect.fail(new RecurringEditUnsupportedError({ eventId }));
        }
        const queued = yield* opsForEvent(calendarId, eventId);
        yield* pendingOpRepo.removeForEvent(calendarId, eventId);
        yield* eventRepo.deleteEvent(accountId, calendarId, eventId);

        const neverSynced = queued.some((op) => op.kind === 'create');
        if (!neverSynced) {
          const now = yield* Clock.currentTimeMillis;
          yield* enqueueAndKick(
            new PendingOp({
              accountId,
              attempts: 0,
              baseEtag: existing.etag ?? undefined,
              calendarId,
              createdAt: now,
              eventId,
              id: generateEventId(),
              kind: 'delete',
              nextAttemptAt: 0,
            }),
          );
        }
      }),

    deleteRecurring: ({ accountId, calendarId, masterId, originalStartUtc, scope }) =>
      Effect.gen(function* () {
        const { master, recurrence } = yield* loadMaster(accountId, calendarId, masterId);
        const now = yield* Clock.currentTimeMillis;

        if (scope === 'instance') {
          // A cancelled override shadows the generated occurrence locally;
          // deleting the instance id cancels it server-side.
          const instanceId = googleInstanceId(masterId, originalStartUtc, master.isAllDay);
          const existing = yield* eventRepo.getById(accountId, calendarId, instanceId);
          const tombstone = new EventRecord({
            ...(existing ?? projectInstance(master, originalStartUtc, now)),
            status: 'cancelled',
            syncStatus: 'pending',
            updatedAt: now,
          });
          yield* eventRepo.upsertMany([tombstone]);
          yield* pendingOpRepo.removeForEvent(calendarId, instanceId);
          yield* enqueueAndKick(
            new PendingOp({
              accountId,
              attempts: 0,
              baseEtag: existing?.etag ?? undefined,
              calendarId,
              createdAt: now,
              eventId: instanceId,
              id: generateEventId(),
              kind: 'delete',
              nextAttemptAt: 0,
            }),
          );
          return;
        }

        if (scope === 'series' || originalStartUtc <= master.startUtc) {
          // Deleting the master cascades to its exceptions server-side.
          const overrides = yield* eventRepo.listOverrides(accountId, calendarId, masterId);
          for (const override of overrides) {
            yield* pendingOpRepo.removeForEvent(calendarId, override.id);
            yield* eventRepo.deleteEvent(accountId, calendarId, override.id);
          }
          yield* pendingOpRepo.removeForEvent(calendarId, masterId);
          yield* eventRepo.deleteEvent(accountId, calendarId, masterId);
          yield* enqueueAndKick(
            new PendingOp({
              accountId,
              attempts: 0,
              baseEtag: master.etag ?? undefined,
              calendarId,
              createdAt: now,
              eventId: masterId,
              id: generateEventId(),
              kind: 'delete',
              nextAttemptAt: 0,
            }),
          );
          return;
        }

        // this-and-following: end the series just before the occurrence.
        const truncated = new EventRecord({
          ...master,
          recurrence: truncateRecurrence(recurrence, originalStartUtc, master.isAllDay),
          syncStatus: 'pending',
          updatedAt: now,
        });
        yield* eventRepo.upsertMany([truncated]);
        yield* pendingOpRepo.removeForEvent(calendarId, masterId);
        yield* enqueueAndKick(
          new PendingOp({
            accountId,
            attempts: 0,
            baseEtag: master.etag ?? undefined,
            calendarId,
            createdAt: now,
            eventId: masterId,
            id: generateEventId(),
            kind: 'update',
            nextAttemptAt: 0,
            payload: truncated,
          }),
        );
        yield* dropOverridesFrom(accountId, calendarId, masterId, originalStartUtc, now);
      }),

    deleteTask: ({ accountId, taskId, taskListId }) =>
      Effect.gen(function* () {
        yield* taskRepo.removeTask(accountId, taskListId, taskId);
        // Everything queued for this task is moot now — and if its create
        // never pushed, the task never existed upstream: no server op.
        const queued = yield* opsForEvent(taskListId, taskId);
        let unsentCreate = false;
        for (const queuedOp of queued) {
          if (queuedOp.accountId !== accountId) {
            continue;
          }
          if (queuedOp.kind === 'createTask') {
            unsentCreate = true;
          }
          yield* pendingOpRepo.remove(queuedOp.id);
        }
        if (unsentCreate) {
          return;
        }
        const now = yield* Clock.currentTimeMillis;
        yield* enqueueAndKick(
          new PendingOp({
            accountId,
            attempts: 0,
            calendarId: taskListId,
            createdAt: now,
            eventId: taskId,
            id: generateEventId(),
            kind: 'deleteTask',
            nextAttemptAt: 0,
            taskListId,
          }),
        );
      }),

    processPendingOps,

    respondToEvent: ({ accountId, calendarId, eventId, response }) =>
      Effect.gen(function* () {
        const existing = yield* eventRepo.getById(accountId, calendarId, eventId);
        if (!existing) {
          return yield* Effect.fail(new EventNotFoundError({ eventId }));
        }
        const accounts = yield* accountRepo.list();
        const ownEmail = accounts.find((account) => account.id === accountId)?.email.toLowerCase();
        const isOwn = (attendee: Attendee) =>
          attendee.isSelf === true || attendee.email.toLowerCase() === ownEmail;
        if (!existing.attendees?.some(isOwn)) {
          return yield* Effect.fail(new NotAttendeeError({ eventId }));
        }
        const now = yield* Clock.currentTimeMillis;
        const merged = new EventRecord({
          ...existing,
          attendees: existing.attendees.map((attendee) =>
            isOwn(attendee) ? new Attendee({ ...attendee, responseStatus: response }) : attendee,
          ),
          syncStatus: 'pending',
          updatedAt: now,
        });
        yield* eventRepo.upsertMany([merged]);
        // Only the latest response needs to reach Google.
        const queued = yield* opsForEvent(calendarId, eventId);
        for (const op of queued) {
          if (op.kind === 'rsvp') {
            yield* pendingOpRepo.remove(op.id);
          }
        }
        yield* enqueueAndKick(
          new PendingOp({
            accountId,
            attempts: 0,
            calendarId,
            createdAt: now,
            eventId,
            id: generateEventId(),
            kind: 'rsvp',
            nextAttemptAt: 0,
            payload: merged,
          }),
        );
      }),

    setCalendarColor: ({ accountId, calendarId, colorHex }) =>
      Effect.gen(function* () {
        const normalized = normalizeHexColor(colorHex);
        if (!normalized) {
          return yield* Effect.fail(new InvalidColorError({ colorHex }));
        }
        yield* calendarRepo.setColor(accountId, calendarId, normalized);
        // Only the latest color needs to reach Google — scoped by account:
        // the same shared calendar id can exist under several accounts.
        const queued = yield* opsForEvent(calendarId, CALENDAR_COLOR_EVENT_ID);
        for (const op of queued) {
          if (op.accountId === accountId) {
            yield* pendingOpRepo.remove(op.id);
          }
        }
        const now = yield* Clock.currentTimeMillis;
        yield* enqueueAndKick(
          new PendingOp({
            accountId,
            attempts: 0,
            calendarId,
            colorHex: normalized,
            createdAt: now,
            eventId: CALENDAR_COLOR_EVENT_ID,
            id: generateEventId(),
            kind: 'calendarColor',
            nextAttemptAt: 0,
          }),
        );
      }),

    updateEvent: ({ accountId, calendarId, changes, eventId }) =>
      Effect.gen(function* () {
        const existing = yield* eventRepo.getById(accountId, calendarId, eventId);
        if (!existing) {
          return yield* Effect.fail(new EventNotFoundError({ eventId }));
        }
        if (existing.recurringEventId || existing.recurrence) {
          return yield* Effect.fail(new RecurringEditUnsupportedError({ eventId }));
        }
        const now = yield* Clock.currentTimeMillis;
        const defined = Object.fromEntries(
          Object.entries(changes).filter(([, value]) => value !== undefined),
        );
        const merged = new EventRecord({
          ...existing,
          ...defined,
          syncStatus: 'pending',
          updatedAt: now,
        });
        yield* eventRepo.upsertMany([merged]);

        // Coalesce: a queued create absorbs the change; otherwise a fresh
        // update op replaces any queued update.
        const queued = yield* opsForEvent(calendarId, eventId);
        yield* pendingOpRepo.removeForEvent(calendarId, eventId);
        const hasCreate = queued.some((op) => op.kind === 'create');
        yield* enqueueAndKick(
          new PendingOp({
            accountId,
            attempts: 0,
            baseEtag: hasCreate ? undefined : (existing.etag ?? undefined),
            calendarId,
            createdAt: now,
            eventId,
            id: generateEventId(),
            kind: hasCreate ? 'create' : 'update',
            nextAttemptAt: 0,
            payload: merged,
          }),
        );
      }),

    updateRecurring: ({ accountId, calendarId, changes, masterId, originalStartUtc, scope }) =>
      Effect.gen(function* () {
        const { master, recurrence } = yield* loadMaster(accountId, calendarId, masterId);
        const now = yield* Clock.currentTimeMillis;
        const defined = Object.fromEntries(
          Object.entries(changes).filter(([, value]) => value !== undefined),
        );

        if (scope === 'instance') {
          // Materialize (or update) the exception under its instance id; the
          // patch on that id creates the exception server-side.
          const instanceId = googleInstanceId(masterId, originalStartUtc, master.isAllDay);
          const existing = yield* eventRepo.getById(accountId, calendarId, instanceId);
          const merged = new EventRecord({
            ...(existing ?? projectInstance(master, originalStartUtc, now)),
            ...defined,
            originalStartUtc,
            recurrence: undefined,
            recurringEventId: masterId,
            syncStatus: 'pending',
            updatedAt: now,
          });
          yield* eventRepo.upsertMany([merged]);
          yield* pendingOpRepo.removeForEvent(calendarId, instanceId);
          yield* enqueueAndKick(
            new PendingOp({
              accountId,
              attempts: 0,
              baseEtag: existing?.etag ?? undefined,
              calendarId,
              createdAt: now,
              eventId: instanceId,
              id: generateEventId(),
              kind: 'update',
              nextAttemptAt: 0,
              payload: merged,
            }),
          );
          return;
        }

        const duration =
          changes.startUtc !== undefined && changes.endUtc !== undefined
            ? changes.endUtc - changes.startUtc
            : master.endUtc - master.startUtc;

        if (scope === 'series' || originalStartUtc <= master.startUtc) {
          // Time edits shift the master (and thus every occurrence) by the
          // occurrence's wall-clock delta — immune to DST offset differences
          // between the occurrence's date and the series start. All-day
          // masters only take non-time fields.
          const startUtc =
            !master.isAllDay && changes.startUtc !== undefined
              ? applyWallClockDelta(
                  master.startUtc,
                  master.startTimeZone ?? 'UTC',
                  originalStartUtc,
                  changes.startUtc,
                )
              : master.startUtc;
          const merged = new EventRecord({
            ...master,
            description: changes.description ?? master.description,
            endUtc: master.isAllDay ? master.endUtc : startUtc + duration,
            location: changes.location ?? master.location,
            startUtc: master.isAllDay ? master.startUtc : startUtc,
            syncStatus: 'pending',
            title: changes.title ?? master.title,
            updatedAt: now,
          });
          yield* eventRepo.upsertMany([merged]);
          yield* pendingOpRepo.removeForEvent(calendarId, masterId);
          yield* enqueueAndKick(
            new PendingOp({
              accountId,
              attempts: 0,
              baseEtag: master.etag ?? undefined,
              calendarId,
              createdAt: now,
              eventId: masterId,
              id: generateEventId(),
              kind: 'update',
              nextAttemptAt: 0,
              payload: merged,
            }),
          );
          return;
        }

        // this-and-following: truncate the old series before the occurrence
        // and start a new master at the (possibly re-timed) occurrence.
        const newRecurrence = remainingRecurrence(
          {
            endDate: master.endDate,
            endUtc: master.endUtc,
            id: master.id,
            isAllDay: master.isAllDay,
            recurrence,
            startDate: master.startDate,
            startTimeZone: master.startTimeZone ?? 'UTC',
            startUtc: master.startUtc,
          },
          originalStartUtc,
        );
        const truncated = new EventRecord({
          ...master,
          recurrence: truncateRecurrence(recurrence, originalStartUtc, master.isAllDay),
          syncStatus: 'pending',
          updatedAt: now,
        });
        yield* eventRepo.upsertMany([truncated]);
        yield* pendingOpRepo.removeForEvent(calendarId, masterId);
        yield* enqueueAndKick(
          new PendingOp({
            accountId,
            attempts: 0,
            baseEtag: master.etag ?? undefined,
            calendarId,
            createdAt: now,
            eventId: masterId,
            id: generateEventId(),
            kind: 'update',
            nextAttemptAt: 0,
            payload: truncated,
          }),
        );
        yield* dropOverridesFrom(accountId, calendarId, masterId, originalStartUtc, now);

        const projected = projectInstance(master, originalStartUtc, now);
        const startUtc =
          !master.isAllDay && changes.startUtc !== undefined
            ? changes.startUtc
            : projected.startUtc;
        const newMaster = new EventRecord({
          ...projected,
          ...defined,
          endUtc: master.isAllDay ? projected.endUtc : startUtc + duration,
          etag: null,
          id: generateEventId(),
          originalStartUtc: undefined,
          recurrence: newRecurrence,
          recurringEventId: undefined,
          startUtc,
          syncedAt: 0,
        });
        yield* eventRepo.upsertMany([newMaster]);
        yield* enqueueAndKick(
          new PendingOp({
            accountId,
            attempts: 0,
            calendarId,
            createdAt: now,
            eventId: newMaster.id,
            id: generateEventId(),
            kind: 'create',
            nextAttemptAt: 0,
            payload: newMaster,
          }),
        );
      }),

    updateTask: ({ accountId, changes, taskId, taskListId }) =>
      Effect.gen(function* () {
        yield* taskRepo.updateLocal({ accountId, changes, listId: taskListId, taskId });
        const now = yield* Clock.currentTimeMillis;
        const queued = yield* opsForEvent(taskListId, taskId);
        const pendingCreate = queued.find(
          (queuedOp) => queuedOp.accountId === accountId && queuedOp.kind === 'createTask',
        );
        if (pendingCreate) {
          // The create hasn't pushed: fold the edit into it instead of
          // patching a task Google has never seen.
          yield* pendingOpRepo.remove(pendingCreate.id);
          yield* enqueueAndKick(
            new PendingOp({
              ...pendingCreate,
              id: generateEventId(),
              ...(changes.dueDate === undefined ? {} : { taskDue: changes.dueDate }),
              ...(changes.notes === undefined ? {} : { taskNotes: changes.notes }),
              ...(changes.title === undefined ? {} : { taskTitle: changes.title }),
            }),
          );
          return;
        }
        // Latest wins: a newer edit supersedes queued ones.
        for (const queuedOp of queued) {
          if (queuedOp.accountId === accountId && queuedOp.kind === 'updateTask') {
            yield* pendingOpRepo.remove(queuedOp.id);
          }
        }
        yield* enqueueAndKick(
          new PendingOp({
            accountId,
            attempts: 0,
            calendarId: taskListId,
            createdAt: now,
            eventId: taskId,
            id: generateEventId(),
            kind: 'updateTask',
            nextAttemptAt: 0,
            ...(changes.dueDate === undefined ? {} : { taskDue: changes.dueDate }),
            taskListId,
            ...(changes.notes === undefined ? {} : { taskNotes: changes.notes }),
            ...(changes.title === undefined ? {} : { taskTitle: changes.title }),
          }),
        );
      }),
  };

  return shape;
});

export class EventMutations extends Context.Service<EventMutations, EventMutationsShape>()(
  'sync/EventMutations',
) {
  static readonly layer: Layer.Layer<
    EventMutations,
    never,
    | AccountRepo
    | CalendarRepo
    | EventRepo
    | GoogleCalendarClient
    | GoogleTasksClient
    | PendingOpRepo
    | Reactivity
    | TaskRepo
  > = Layer.effect(EventMutations)(make);
}
