import {
  applyWallClockDelta,
  Attendee,
  EventRecord,
  googleInstanceId,
  normalizeHexColor,
  PendingOp,
  remainingRecurrence,
  truncateRecurrence,
} from '@calendar/core';
import { AccountRepo, CalendarRepo, EventRepo, PendingOpRepo, TaskRepo } from '@calendar/db';
import { CONFLICT_NOTICE_KEY } from '@calendar/db/keys';
import { generateEventId, GoogleCalendarClient, GoogleTasksClient } from '@calendar/google';
import { RemindersClient } from '@calendar/reminders';
import { Clock, Context, Effect, Layer, Semaphore } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { makeApplyOp } from './applyOp.ts';
import {
  CALENDAR_COLOR_EVENT_ID,
  EventNotFoundError,
  type EventMutationsShape,
  InvalidColorError,
  NotAttendeeError,
  RecurringEditUnsupportedError,
  retryDelayMs,
  UnsupportedForProviderError,
} from './mutationTypes.ts';
import { makeReminderMutations } from './reminderMutations.ts';
import { makeTaskMutations } from './taskMutations.ts';

export * from './mutationTypes.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDate = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

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
  | RemindersClient
  | TaskRepo
> = Effect.gen(function* () {
  const reactivity = yield* Reactivity;
  const remindersClient = yield* RemindersClient;
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

  const applyOp = makeApplyOp({
    accountRepo,
    calendarRepo,
    client,
    eventRepo,
    notifyConflict: Effect.ignore(reactivity.invalidate([CONFLICT_NOTICE_KEY])),
    pendingOpRepo,
    taskRepo,
    tasksClient,
  });

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

  const googleTasks = makeTaskMutations({
    enqueueAndKick,
    opsForEvent,
    pendingOpRepo,
    taskRepo,
  });
  const reminders = makeReminderMutations({ accountRepo, remindersClient, taskRepo });

  /** Google lists go through the pending-op queue; Reminders lists hit EventKit directly. */
  const providerOf = (accountId: string) =>
    Effect.map(
      accountRepo.list(),
      (accounts) => accounts.find((account) => account.id === accountId)?.provider ?? 'google',
    );
  const REMINDER_ONLY_FIELDS = [
    'alarms',
    'dueTime',
    'moveToListId',
    'priority',
    'recurrence',
    'url',
  ] as const;
  const rejectReminderFields = (
    fields: Partial<Record<(typeof REMINDER_ONLY_FIELDS)[number], unknown>>,
  ) =>
    Effect.gen(function* () {
      for (const field of REMINDER_ONLY_FIELDS) {
        if (fields[field] !== undefined) {
          return yield* Effect.fail(new UnsupportedForProviderError({ field, provider: 'google' }));
        }
      }
    });

  const taskMutations: Pick<
    EventMutationsShape,
    'completeTask' | 'createTask' | 'deleteTask' | 'updateTask'
  > = {
    completeTask: (params) =>
      Effect.flatMap(providerOf(params.accountId), (provider) =>
        provider === 'apple' ? reminders.completeTask(params) : googleTasks.completeTask(params),
      ),
    createTask: (params) =>
      Effect.flatMap(providerOf(params.accountId), (provider) =>
        provider === 'apple'
          ? reminders.createTask(params)
          : Effect.andThen(rejectReminderFields(params), googleTasks.createTask(params)),
      ),
    deleteTask: (params) =>
      Effect.flatMap(providerOf(params.accountId), (provider) =>
        provider === 'apple' ? reminders.deleteTask(params) : googleTasks.deleteTask(params),
      ),
    updateTask: (params) =>
      Effect.flatMap(providerOf(params.accountId), (provider) =>
        provider === 'apple'
          ? reminders.updateTask(params)
          : Effect.andThen(rejectReminderFields(params.changes), googleTasks.updateTask(params)),
      ),
  };

  const shape: EventMutationsShape = {
    ...taskMutations,
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
    | RemindersClient
    | TaskRepo
  > = Layer.effect(EventMutations)(make);
}
