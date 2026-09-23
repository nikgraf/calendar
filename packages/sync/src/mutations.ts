import {
  AppleCalendarClient,
  mapAppleEvent,
  type AppleCalendarClientShape,
} from '@calendar/apple-calendar';
import {
  applyWallClockDelta,
  Attendee,
  canonicalReminders,
  type EventDraft,
  EventRecord,
  EventReminders,
  googleInstanceId,
  isServerMove,
  mergeAttendees,
  meetingUrl,
  type MoveEventParams,
  moveLoss,
  type MoveTaskParams,
  normalizeHexColor,
  PendingOp,
  remainingRecurrence,
  type ReminderOverride,
  toRRuleLines,
  toStructuredRules,
  truncateRecurrence,
  withConsistentGeo,
} from '@calendar/core';
import { AccountRepo, CalendarRepo, EventRepo, PendingOpRepo, TaskRepo } from '@calendar/db';
import { DROPPED_NOTICE_KEY } from '@calendar/db/keys';
import {
  type GcalEvent,
  generateEventId,
  GoogleCalendarClient,
  GoogleTasksClient,
  mapGcalEvent,
} from '@calendar/google';
import { RemindersClient } from '@calendar/reminders';
import { Cause, Clock, Context, Effect, Layer, Semaphore } from 'effect';
import { Reactivity } from 'effect/unstable/reactivity/Reactivity';
import { SqlClient } from 'effect/unstable/sql/SqlClient';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import { makeApplyOp } from './applyOp.ts';
import { AppleCalendarEvents, deviceTimeZone } from './appleCalendarEvents.ts';
import { makeAppleEventMutations } from './appleEventMutations.ts';
import {
  CALENDAR_COLOR_EVENT_ID,
  CalendarNotWritableError,
  ConflictNotResolvableError,
  EventNotFoundError,
  type EventMutationsShape,
  InvalidColorError,
  NotAttendeeError,
  NotOrganizerError,
  RecurringEditUnsupportedError,
  retryDelayMs,
  TaskNotFoundError,
  UnsupportedForProviderError,
  type UpdateEventParams,
} from './mutationTypes.ts';
import { makeReminderMutations } from './reminderMutations.ts';
import { cancelledOverrideTombstone } from './tombstone.ts';
import { makeTaskMutations } from './taskMutations.ts';

export * from './mutationTypes.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDate = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

/**
 * The defined fields of an update, ready to spread over an EventRecord.
 * `attendees` is the editor's replacement list and is merged against the
 * current guests so server facts (responses, organizer) survive.
 */
/** Whether this edit — or a still-queued update it replaces — touched the guest list. */
const attendeesFlag = (
  changes: UpdateEventParams['changes'],
  queued: ReadonlyArray<PendingOp>,
): true | undefined =>
  changes.attendees !== undefined || queued.some((op) => op.attendeesChanged === true)
    ? true
    : undefined;

/**
 * Whether this edit — or a still-queued update it replaces — dropped the
 * event's coordinates, so the patch must delete the server's geo keys.
 */
const geoClearedFlag = (
  before: EventRecord,
  after: EventRecord,
  queued: ReadonlyArray<PendingOp>,
): true | undefined =>
  (before.geo !== undefined && after.geo === undefined) ||
  queued.some((op) => op.geoCleared === true)
    ? true
    : undefined;

/** Whether this edit — or a still-queued update it replaces — touched the reminders. */
const remindersFlag = (
  changes: UpdateEventParams['changes'],
  queued: ReadonlyArray<PendingOp>,
): true | undefined =>
  changes.reminders !== undefined || queued.some((op) => op.remindersChanged === true)
    ? true
    : undefined;

const definedChanges = (
  changes: UpdateEventParams['changes'],
  currentAttendees: EventRecord['attendees'],
): Partial<EventRecord> => {
  const { attendees, geo, reminders, ...rest } = changes;
  const defined: Partial<EventRecord> = Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== undefined),
  );
  // null clears: an explicit undefined overrides the record's geo in the spread.
  const withGeo = geo === undefined ? defined : { ...defined, geo: geo ?? undefined };
  const withReminders =
    reminders === undefined ? withGeo : { ...withGeo, reminders: canonicalReminders(reminders) };
  return attendees === undefined
    ? withReminders
    : { ...withReminders, attendees: mergeAttendees(currentAttendees, attendees) };
};

/**
 * A guest cannot re-home an invitation: the organizer (or, for a Google
 * secondary calendar, the calendar itself) must be us. Events without
 * an organizer are our own.
 */
const ensureOrganizer = (record: EventRecord, ownEmail: string | undefined, calendarId: string) =>
  Effect.suspend(() => {
    const organizer = record.organizerEmail?.toLowerCase();
    const selfOrganizes = record.attendees?.some(
      (attendee) => attendee.isOrganizer === true && attendee.isSelf === true,
    );
    const ours =
      organizer === undefined ||
      selfOrganizes === true ||
      organizer === ownEmail?.toLowerCase() ||
      organizer === calendarId.toLowerCase();
    return ours ? Effect.void : Effect.fail(new NotOrganizerError({ eventId: record.id }));
  });

interface MoveSource {
  /** Google only: what the master's `useDefault` resolves to on its calendar. */
  readonly defaultReminders: ReadonlyArray<ReminderOverride> | undefined;
  /** The event as a series master (occurrence ids and slots stripped). */
  readonly master: EventRecord;
  readonly modifiedOccurrences: number;
  /** Apple only: the event's URL (non-meeting URLs are not on the record). */
  readonly url: string | undefined;
}

/** The new event a copy-move creates: never guests, links carried where they fit. */
const copyDraft = (
  source: MoveSource,
  target: MoveEventParams['target'],
  targetProvider: 'apple' | 'google',
): EventDraft => {
  const { master } = source;
  let description = master.description;
  let url: string | undefined;
  if (targetProvider === 'apple') {
    url = master.hangoutLink ?? meetingUrl(master) ?? source.url;
  } else {
    const link = source.url ?? master.hangoutLink;
    if (link && !(description ?? '').includes(link) && !(master.location ?? '').includes(link)) {
      description = [description, link].filter(Boolean).join('\n\n');
    }
  }
  // Rule parts EventKit cannot store were confirmed away (moveLoss names them).
  const recurrence =
    master.recurrence && targetProvider === 'apple'
      ? toRRuleLines(
          toStructuredRules(master.recurrence, master.isAllDay, master.startTimeZone ?? 'UTC')
            .rules,
          master.isAllDay,
        )
      : master.recurrence;
  // EventKit has no "calendar default": a deferring event takes its
  // calendar's popup defaults along as explicit alarms (email ones were
  // confirmed away). Google → Google keeps the object as it is.
  const reminders =
    targetProvider === 'apple'
      ? new EventReminders({
          overrides: (master.reminders === undefined || master.reminders.useDefault
            ? (source.defaultReminders ?? [])
            : master.reminders.overrides
          ).filter((override) => override.method === 'popup'),
          useDefault: false,
        })
      : master.reminders;
  return {
    accountId: target.accountId,
    calendarId: target.calendarId,
    ...(description ? { description } : {}),
    ...(master.isAllDay ? { endDate: master.endDate, startDate: master.startDate } : {}),
    endUtc: master.endUtc,
    ...(master.geo ? { geo: master.geo } : {}),
    isAllDay: master.isAllDay,
    ...(master.location ? { location: master.location } : {}),
    ...(recurrence && recurrence.length > 0 ? { recurrence } : {}),
    ...(reminders ? { reminders } : {}),
    ...(master.isAllDay ? {} : { startTimeZone: master.startTimeZone }),
    startUtc: master.startUtc,
    title: master.title,
    ...(url ? { url } : {}),
  };
};

const make: Effect.Effect<
  EventMutationsShape,
  never,
  | AccountRepo
  | AppleCalendarClient
  | AppleCalendarEvents
  | CalendarRepo
  | EventRepo
  | GoogleCalendarClient
  | GoogleTasksClient
  | PendingOpRepo
  | Reactivity
  | RemindersClient
  | SqlClient
  | TaskRepo
> = Effect.gen(function* () {
  const sql = yield* SqlClient;
  const reactivity = yield* Reactivity;
  const remindersClient = yield* RemindersClient;
  const appleClient: AppleCalendarClientShape = yield* AppleCalendarClient;
  const appleEvents = yield* AppleCalendarEvents;
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

  const enqueue = (op: PendingOp) => pendingOpRepo.enqueue(op);
  const kick = Effect.suspend(() => Effect.forkDetach(processPendingOps()));
  /**
   * A mutation's local write and its queue changes (coalesce old ops,
   * enqueue the new one) commit together: a crash between the two used
   * to leave a `pending` row with no op behind it — an edit that never
   * reached Google and that the next pull overwrote. The drain kicks
   * only after the commit, so it never sees a half-written queue.
   */
  const transactional = <A, E, R>(
    body: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | SqlError, R> => Effect.tap(sql.withTransaction(body), () => kick);

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
        yield* enqueue(
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
            payload: override,
          }),
        );
      }
    });

  const { apply: applyOp, releaseRow } = makeApplyOp({
    accountRepo,
    calendarRepo,
    client,
    eventRepo,
    notifyDropped: Effect.ignore(reactivity.invalidate([DROPPED_NOTICE_KEY])),
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
            } else if ('conflict' in outcome) {
              // Parked until the user chooses (resolveConflict); the local
              // row stays pending so pulls cannot overwrite their version.
              yield* pendingOpRepo.markConflict(op.id, now, outcome.conflict ?? undefined);
            } else {
              // The reason lands in pending_ops.last_error, which the
              // unsynced-changes panel shows next to the retry count.
              yield* pendingOpRepo.markFailed(
                op.id,
                op.attempts + 1,
                now + retryDelayMs(op.attempts),
                outcome.retry,
              );
            }
          }
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logError('pending-op drain failed', { cause: String(Cause.squash(cause)) }),
        ),
      );

  const discardPendingOp: EventMutationsShape['discardPendingOp'] = (opId) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const op = yield* pendingOpRepo.getById(opId);
        yield* pendingOpRepo.remove(opId);
        if (op) {
          yield* releaseRow(op);
        }
      }),
    );

  /**
   * Keep mine: re-send without If-Match. A parked delete also clears a
   * copy a pull re-inserted while it waited (a pending row — an instance
   * tombstone — is the user's own and stays). An edit of an event Google
   * deleted is restored as a new event: patching it would 404 and the
   * NotFound arm would drop the edit.
   */
  const keepMine = (op: PendingOp, now: number) =>
    Effect.gen(function* () {
      if (op.kind === 'delete') {
        const row = yield* eventRepo.getById(op.accountId, op.calendarId, op.eventId);
        if (row && row.syncStatus !== 'pending') {
          yield* eventRepo.deleteEvent(op.accountId, op.calendarId, op.eventId);
        }
        return yield* pendingOpRepo.unpark(op.id, now);
      }
      if (op.serverPayload && op.serverPayload.status !== 'cancelled') {
        return yield* pendingOpRepo.unpark(op.id, now);
      }
      yield* pendingOpRepo.remove(op.id);
      if (!op.payload) {
        return yield* releaseRow(op);
      }
      // A standalone copy: the series (or occurrence) it belonged to is
      // gone, so it cannot be an override of it any more.
      const restored = new EventRecord({
        ...op.payload,
        etag: null,
        id: generateEventId(),
        originalStartUtc: undefined,
        recurringEventId: undefined,
        syncStatus: 'pending',
        updatedAt: now,
      });
      yield* eventRepo.deleteEvent(op.accountId, op.calendarId, op.eventId);
      yield* eventRepo.upsertMany([restored]);
      yield* enqueue(
        new PendingOp({
          accountId: op.accountId,
          attempts: 0,
          calendarId: op.calendarId,
          createdAt: now,
          eventId: restored.id,
          id: generateEventId(),
          kind: 'create',
          nextAttemptAt: 0,
          payload: restored,
        }),
      );
    });

  /** Take theirs: Google's current copy (undefined = gone) replaces the local row. */
  const takeTheirs = (op: PendingOp, item: GcalEvent | undefined, now: number) =>
    Effect.gen(function* () {
      const context = { accountId: op.accountId, calendarId: op.calendarId, syncedAt: now };
      const record =
        item === undefined
          ? null
          : item.status === 'cancelled'
            ? cancelledOverrideTombstone(item, context)
            : mapGcalEvent(item, {
                ...context,
                defaultTimeZone: op.payload?.startTimeZone ?? 'UTC',
              });
      if (record) {
        // Ack mode: overwrites the pending row the pulls skipped.
        yield* eventRepo.upsertMany([record]);
      } else {
        yield* eventRepo.deleteEvent(op.accountId, op.calendarId, op.eventId);
      }
      yield* pendingOpRepo.remove(op.id);
    });

  const resolveConflict: EventMutationsShape['resolveConflict'] = ({ choice, opId }) =>
    Effect.gen(function* () {
      const op = yield* pendingOpRepo.getById(opId);
      if (!op || op.conflictAt === undefined) {
        return;
      }
      if (choice === 'mine') {
        // transactional kicks the drain once the unpark committed.
        return yield* transactional(
          Effect.flatMap(Clock.currentTimeMillis, (now) => keepMine(op, now)),
        );
      }
      // After a move the op points at the destination, where Google has
      // nothing until the move lands; a fetch there would 404 and delete
      // the user's row.
      if ((yield* pendingOpRepo.earlierInSeries(op)).includes('move')) {
        return yield* Effect.fail(
          new ConflictNotResolvableError({
            message: 'The event is still moving to another calendar — try again once it synced.',
          }),
        );
      }
      // The stored copy is only a preview: Google may have moved on while
      // the op was parked, so fetch what it has now.
      const item = yield* client
        .getEvent({ accountId: op.accountId, calendarId: op.calendarId, eventId: op.eventId })
        .pipe(
          Effect.map((event): GcalEvent | undefined => event),
          Effect.catchTag('NotFoundError', () => Effect.succeed(undefined)),
        );
      const now = yield* Clock.currentTimeMillis;
      yield* sql.withTransaction(
        Effect.gen(function* () {
          // The user may have edited (re-queued) or resolved it meanwhile.
          const current = yield* pendingOpRepo.getById(opId);
          if (current?.conflictAt !== undefined) {
            yield* takeTheirs(current, item, now);
          }
        }),
      );
    });

  const googleTasks = makeTaskMutations({
    enqueue,
    opsForEvent,
    pendingOpRepo,
    taskRepo,
  });
  const reminders = makeReminderMutations({ accountRepo, remindersClient, taskRepo });

  /** Google lists go through the pending-op queue; Reminders lists hit EventKit directly. */
  const providerOf = (accountId: string) =>
    Effect.map(accountRepo.get(accountId), (account) => account?.provider ?? 'google');
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
        provider === 'apple'
          ? reminders.completeTask(params)
          : transactional(googleTasks.completeTask(params)),
      ),
    createTask: (params) =>
      Effect.flatMap(providerOf(params.accountId), (provider) =>
        provider === 'apple'
          ? reminders.createTask(params)
          : Effect.andThen(
              rejectReminderFields(params),
              transactional(googleTasks.createTask(params)),
            ),
      ),
    deleteTask: (params) =>
      Effect.flatMap(providerOf(params.accountId), (provider) =>
        provider === 'apple'
          ? reminders.deleteTask(params)
          : transactional(googleTasks.deleteTask(params)),
      ),
    updateTask: (params) =>
      Effect.flatMap(providerOf(params.accountId), (provider) =>
        provider === 'apple'
          ? reminders.updateTask(params)
          : Effect.andThen(
              rejectReminderFields(params.changes),
              transactional(googleTasks.updateTask(params)),
            ),
      ),
  };

  const shape: Omit<EventMutationsShape, 'moveEvent' | 'moveTask' | 'previewMove'> = {
    ...taskMutations,
    createEvent: (draft) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        // Every write below goes through withConsistentGeo: coordinates
        // that no longer match the location text are never stored or pushed.
        const record = withConsistentGeo(
          new EventRecord({
            accountId: draft.accountId,
            // Google adds the organizer itself; the insert response fills it in.
            attendees: draft.attendees?.length
              ? mergeAttendees(undefined, draft.attendees)
              : undefined,
            calendarId: draft.calendarId,
            description: draft.description,
            endDate: draft.endDate,
            endUtc: draft.endUtc,
            etag: null,
            geo: draft.geo,
            id: generateEventId(),
            isAllDay: draft.isAllDay,
            location: draft.location,
            recurrence: draft.recurrence,
            reminders: draft.reminders ? canonicalReminders(draft.reminders) : undefined,
            startDate: draft.startDate,
            startTimeZone: draft.startTimeZone,
            startUtc: draft.startUtc,
            status: 'confirmed',
            syncedAt: 0,
            syncStatus: 'pending',
            title: draft.title,
            updatedAt: now,
          }),
        );
        yield* eventRepo.upsertMany([record]);
        yield* enqueue(
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
          yield* enqueue(
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
              // Snapshot of what was deleted: names a parked 412 in the UI.
              payload: existing,
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
          yield* enqueue(
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
              payload: tombstone,
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
          yield* enqueue(
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
              payload: master,
            }),
          );
          return;
        }

        // this-and-following: end the series just before the occurrence.
        const truncated = new EventRecord({
          ...master,
          recurrence: truncateRecurrence(
            recurrence,
            originalStartUtc,
            master.isAllDay,
            master.startTimeZone ?? 'UTC',
          ),
          syncStatus: 'pending',
          updatedAt: now,
        });
        yield* eventRepo.upsertMany([truncated]);
        yield* pendingOpRepo.removeForEvent(calendarId, masterId);
        yield* enqueue(
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

    discardPendingOp,

    processPendingOps,

    resolveConflict,

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
        yield* enqueue(
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
        yield* enqueue(
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
        const merged = withConsistentGeo(
          new EventRecord({
            ...existing,
            ...definedChanges(changes, existing.attendees),
            syncStatus: 'pending',
            updatedAt: now,
          }),
        );
        yield* eventRepo.upsertMany([merged]);

        // Coalesce: a queued create absorbs the change; otherwise a fresh
        // update op replaces any queued update — and inherits its guest-list
        // flag, since the merged record still carries that edit.
        const queued = yield* opsForEvent(calendarId, eventId);
        yield* pendingOpRepo.removeForEvent(calendarId, eventId);
        const hasCreate = queued.some((op) => op.kind === 'create');
        yield* enqueue(
          new PendingOp({
            accountId,
            attempts: 0,
            attendeesChanged: hasCreate ? undefined : attendeesFlag(changes, queued),
            baseEtag: hasCreate ? undefined : (existing.etag ?? undefined),
            calendarId,
            createdAt: now,
            eventId,
            geoCleared: hasCreate ? undefined : geoClearedFlag(existing, merged, queued),
            id: generateEventId(),
            kind: hasCreate ? 'create' : 'update',
            nextAttemptAt: 0,
            payload: merged,
            remindersChanged: hasCreate ? undefined : remindersFlag(changes, queued),
          }),
        );
      }),

    updateRecurring: ({ accountId, calendarId, changes, masterId, originalStartUtc, scope }) =>
      Effect.gen(function* () {
        const { master, recurrence } = yield* loadMaster(accountId, calendarId, masterId);
        const now = yield* Clock.currentTimeMillis;
        // Series/following edits merge guests against the master; an
        // instance edit merges against the occurrence's own list below —
        // an override can carry responses the master does not.
        const defined = definedChanges(changes, master.attendees);

        if (scope === 'instance') {
          // Materialize (or update) the exception under its instance id; the
          // patch on that id creates the exception server-side.
          const instanceId = googleInstanceId(masterId, originalStartUtc, master.isAllDay);
          const existing = yield* eventRepo.getById(accountId, calendarId, instanceId);
          const base = existing ?? projectInstance(master, originalStartUtc, now);
          const merged = withConsistentGeo(
            new EventRecord({
              ...base,
              ...definedChanges(changes, base.attendees),
              originalStartUtc,
              recurrence: undefined,
              recurringEventId: masterId,
              syncStatus: 'pending',
              updatedAt: now,
            }),
          );
          yield* eventRepo.upsertMany([merged]);
          const queued = yield* opsForEvent(calendarId, instanceId);
          yield* pendingOpRepo.removeForEvent(calendarId, instanceId);
          yield* enqueue(
            new PendingOp({
              accountId,
              attempts: 0,
              attendeesChanged: attendeesFlag(changes, queued),
              baseEtag: existing?.etag ?? undefined,
              calendarId,
              createdAt: now,
              eventId: instanceId,
              geoCleared: geoClearedFlag(base, merged, queued),
              id: generateEventId(),
              kind: 'update',
              nextAttemptAt: 0,
              payload: merged,
              remindersChanged: remindersFlag(changes, queued),
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
          const merged = withConsistentGeo(
            new EventRecord({
              ...master,
              attendees: defined.attendees ?? master.attendees,
              description: changes.description ?? master.description,
              endUtc: master.isAllDay ? master.endUtc : startUtc + duration,
              geo: changes.geo === undefined ? master.geo : (changes.geo ?? undefined),
              location: changes.location ?? master.location,
              reminders: defined.reminders ?? master.reminders,
              startUtc: master.isAllDay ? master.startUtc : startUtc,
              syncStatus: 'pending',
              title: changes.title ?? master.title,
              updatedAt: now,
            }),
          );
          yield* eventRepo.upsertMany([merged]);
          const queued = yield* opsForEvent(calendarId, masterId);
          yield* pendingOpRepo.removeForEvent(calendarId, masterId);
          yield* enqueue(
            new PendingOp({
              accountId,
              attempts: 0,
              attendeesChanged: attendeesFlag(changes, queued),
              baseEtag: master.etag ?? undefined,
              calendarId,
              createdAt: now,
              eventId: masterId,
              geoCleared: geoClearedFlag(master, merged, queued),
              id: generateEventId(),
              kind: 'update',
              nextAttemptAt: 0,
              payload: merged,
              remindersChanged: remindersFlag(changes, queued),
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
          recurrence: truncateRecurrence(
            recurrence,
            originalStartUtc,
            master.isAllDay,
            master.startTimeZone ?? 'UTC',
          ),
          syncStatus: 'pending',
          updatedAt: now,
        });
        yield* eventRepo.upsertMany([truncated]);
        yield* pendingOpRepo.removeForEvent(calendarId, masterId);
        yield* enqueue(
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
        const newMaster = withConsistentGeo(
          new EventRecord({
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
          }),
        );
        yield* eventRepo.upsertMany([newMaster]);
        yield* enqueue(
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

  // Every queue-backed method runs inside one transaction (see
  // `transactional`); the EventKit paths (Reminders, Apple Calendar)
  // write the local store synchronously and need none.
  const google = {
    createEvent: (draft: EventDraft) => transactional(shape.createEvent(draft)),
    deleteEvent: (params: Parameters<EventMutationsShape['deleteEvent']>[0]) =>
      transactional(shape.deleteEvent(params)),
    deleteRecurring: (params: Parameters<EventMutationsShape['deleteRecurring']>[0]) =>
      transactional(shape.deleteRecurring(params)),
    respondToEvent: (params: Parameters<EventMutationsShape['respondToEvent']>[0]) =>
      transactional(shape.respondToEvent(params)),
    setCalendarColor: (params: Parameters<EventMutationsShape['setCalendarColor']>[0]) =>
      transactional(shape.setCalendarColor(params)),
    updateEvent: (params: Parameters<EventMutationsShape['updateEvent']>[0]) =>
      transactional(shape.updateEvent(params)),
    updateRecurring: (params: Parameters<EventMutationsShape['updateRecurring']>[0]) =>
      transactional(shape.updateRecurring(params)),
  };
  const apple = makeAppleEventMutations({
    accountRepo,
    appleEvents,
    calendarRepo,
    client: appleClient,
  });

  // ---- moves ----

  const findCalendar = (accountId: string, calendarId: string) =>
    Effect.map(calendarRepo.list(accountId), (calendars) =>
      calendars.find((calendar) => calendar.id === calendarId),
    );

  /** The source event as a whole (the series for a recurring one). */
  const loadSource = (params: MoveEventParams, provider: 'apple' | 'google') =>
    Effect.gen(function* () {
      const { accountId, calendarId, eventId } = params;
      if (provider === 'apple') {
        const series = yield* appleClient.series({ id: eventId });
        const now = yield* Clock.currentTimeMillis;
        const mapped = mapAppleEvent(series.first, { deviceTimeZone: deviceTimeZone(), now });
        const recurrence = toRRuleLines(series.rules, series.first.isAllDay);
        return {
          defaultReminders: undefined,
          master: new EventRecord({
            ...mapped,
            id: eventId,
            originalStartUtc: undefined,
            recurrence: recurrence.length > 0 ? recurrence : undefined,
            recurringEventId: undefined,
          }),
          modifiedOccurrences: series.detachedCount,
          url: series.first.url,
        } satisfies MoveSource;
      }
      const master = yield* eventRepo.getById(accountId, calendarId, eventId);
      if (!master) {
        return yield* Effect.fail(new EventNotFoundError({ eventId }));
      }
      if (master.recurringEventId) {
        // One occurrence cannot leave its series; moves take the whole series.
        return yield* Effect.fail(new RecurringEditUnsupportedError({ eventId }));
      }
      const overrides = master.recurrence
        ? yield* eventRepo.listOverrides(accountId, calendarId, eventId)
        : [];
      const calendar = (yield* calendarRepo.list(accountId)).find((c) => c.id === calendarId);
      return {
        defaultReminders: calendar?.defaultReminders,
        master,
        modifiedOccurrences: overrides.length,
        url: undefined,
      } satisfies MoveSource;
    });

  /**
   * Google → Google inside one account: events.move keeps the id, guests,
   * conference and exceptions. Rows are re-keyed to the target now; any
   * queued edit of the series is re-queued *behind* the move against the
   * target calendar (the drain holds either side back until the other
   * lands — see applyOp), and a create that never reached Google simply
   * becomes a create in the target.
   */
  const googleServerMove = (params: MoveEventParams) =>
    Effect.gen(function* () {
      const { accountId, calendarId, eventId, target } = params;
      const { master } = yield* loadSource(params, 'google');
      const account = yield* accountRepo.get(accountId);
      yield* ensureOrganizer(master, account?.email, calendarId);
      const now = yield* Clock.currentTimeMillis;
      const overrides = master.recurrence
        ? yield* eventRepo.listOverrides(accountId, calendarId, eventId)
        : [];
      for (const row of [master, ...overrides]) {
        yield* eventRepo.deleteEvent(accountId, calendarId, row.id);
        yield* eventRepo.upsertMany([
          new EventRecord({ ...row, calendarId: target.calendarId, syncStatus: 'pending' }),
        ]);
      }
      const seriesIds = new Set([master.id, ...overrides.map((row) => row.id)]);
      const queued = (yield* pendingOpRepo.listAll()).filter(
        (op) =>
          op.accountId === accountId && op.calendarId === calendarId && seriesIds.has(op.eventId),
      );
      for (const op of queued) {
        yield* pendingOpRepo.remove(op.id);
      }
      // The move itself bumps the event's etag, so a re-queued edit must
      // not send its pre-move If-Match: it would 412 and park. A parked op
      // stays parked (conflictAt rides along): dropping the park with the
      // etag would silently decide the conflict for the user.
      const retarget = (record: EventRecord | undefined) =>
        record ? new EventRecord({ ...record, calendarId: target.calendarId }) : undefined;
      const rekey = (op: PendingOp, createdAt: number) =>
        new PendingOp({
          ...op,
          attempts: 0,
          baseEtag: undefined,
          calendarId: target.calendarId,
          createdAt,
          id: generateEventId(),
          lastError: op.conflictAt === undefined ? undefined : op.lastError,
          nextAttemptAt: 0,
          payload: retarget(op.payload),
          serverPayload: retarget(op.serverPayload),
        });
      const pendingCreate = queued.find((op) => op.kind === 'create' && op.eventId === master.id);
      if (!pendingCreate) {
        yield* enqueue(
          new PendingOp({
            accountId,
            attempts: 0,
            calendarId,
            createdAt: now,
            eventId: master.id,
            id: generateEventId(),
            kind: 'move',
            nextAttemptAt: 0,
            targetCalendarId: target.calendarId,
          }),
        );
      }
      for (const op of queued) {
        yield* enqueue(rekey(op, now + 1));
      }
    });

  const createIn = (provider: 'apple' | 'google', draft: EventDraft) =>
    provider === 'apple' ? apple.createEvent(draft) : shape.createEvent(draft);

  const deleteFrom = (
    provider: 'apple' | 'google',
    params: MoveEventParams,
    master: EventRecord,
  ) =>
    master.recurrence
      ? (provider === 'apple' ? apple : shape).deleteRecurring({
          accountId: params.accountId,
          calendarId: params.calendarId,
          masterId: params.eventId,
          originalStartUtc: master.startUtc,
          scope: 'series',
        })
      : (provider === 'apple' ? apple : shape).deleteEvent({
          accountId: params.accountId,
          calendarId: params.calendarId,
          eventId: params.eventId,
        });

  const routeOf = (params: MoveEventParams) =>
    Effect.gen(function* () {
      const source = yield* providerOf(params.accountId);
      const target = yield* providerOf(params.target.accountId);
      return { sameAccount: params.accountId === params.target.accountId, source, target };
    });

  const moveEvent = (params: MoveEventParams) =>
    Effect.gen(function* () {
      const { accountId, calendarId, target } = params;
      if (target.accountId === accountId && target.calendarId === calendarId) {
        return;
      }
      const targetCalendar = yield* findCalendar(target.accountId, target.calendarId);
      if (
        !targetCalendar ||
        (targetCalendar.accessRole !== 'owner' && targetCalendar.accessRole !== 'writer')
      ) {
        return yield* Effect.fail(new CalendarNotWritableError({ calendarId: target.calendarId }));
      }
      const route = yield* routeOf(params);
      if (isServerMove(route)) {
        return yield* transactional(googleServerMove(params));
      }
      if (route.source === 'apple' && route.target === 'apple') {
        return yield* apple.moveWithin({
          accountId,
          calendarId: target.calendarId,
          id: params.eventId,
        });
      }
      // Copy, then delete: a failure between the two leaves a duplicate,
      // never a lost event.
      const source = yield* loadSource(params, route.source);
      const account = yield* accountRepo.get(accountId);
      yield* ensureOrganizer(source.master, account?.email, calendarId);
      const draft = copyDraft(source, target, route.target);
      const both = Effect.andThen(
        createIn(route.target, draft),
        deleteFrom(route.source, params, source.master),
      );
      // Google → Google across accounts: both queue writes in one transaction.
      yield* route.source === 'google' && route.target === 'google'
        ? transactional(both)
        : route.target === 'google'
          ? Effect.andThen(
              transactional(createIn('google', draft)),
              deleteFrom('apple', params, source.master),
            )
          : Effect.andThen(
              createIn('apple', draft),
              transactional(deleteFrom('google', params, source.master)),
            );
    });

  const previewMove = (params: MoveEventParams) =>
    Effect.gen(function* () {
      const route = yield* routeOf(params);
      if (isServerMove(route) || (route.source === 'apple' && route.target === 'apple')) {
        return moveLoss({ isAllDay: false }, route, 0);
      }
      const source = yield* loadSource(params, route.source);
      return moveLoss(source.master, route, source.modifiedOccurrences);
    });

  /**
   * Moving a task: between two Reminders lists EventKit changes the list
   * in place and the identifier survives; every other route creates the
   * task in the target from the draft and then deletes the source, so a
   * failure between the two leaves a duplicate, never a lost task. The
   * draft, not the source row, is what gets written: the editor showed
   * the target provider's form, and its fields are the user's intent.
   * Completion follows the task.
   */
  const moveTask = (params: MoveTaskParams) =>
    Effect.gen(function* () {
      const { accountId, draft, target, taskId, taskListId } = params;
      const source = yield* taskRepo.get(accountId, taskListId, taskId);
      if (!source) {
        return yield* Effect.fail(new TaskNotFoundError({ taskId }));
      }
      if (target.accountId === accountId && target.taskListId === taskListId) {
        return source;
      }
      const sourceProvider = yield* providerOf(accountId);
      const targetProvider = yield* providerOf(target.accountId);
      if (sourceProvider === 'apple' && targetProvider === 'apple') {
        // One EventKit store: the reminder keeps its identifier; the draft
        // replaces its fields, except a repeat rule the app cannot express.
        yield* reminders.updateTask({
          accountId,
          changes: {
            alarms: draft.alarms ?? null,
            dueDate: draft.dueDate,
            dueTime: draft.dueTime ?? null,
            moveToListId: target.taskListId,
            notes: draft.notes ?? '',
            priority: draft.priority ?? null,
            ...(source.recurrenceUnsupported ? {} : { recurrence: draft.recurrence ?? null }),
            title: draft.title,
            url: draft.url ?? null,
          },
          taskId,
          taskListId,
        });
        const moved = yield* taskRepo.get(accountId, target.taskListId, taskId);
        return moved ?? source;
      }
      const createParams = { ...draft, accountId: target.accountId, taskListId: target.taskListId };
      const createIn = (provider: 'apple' | 'google') =>
        Effect.gen(function* () {
          const created =
            provider === 'apple'
              ? yield* reminders.createTask(createParams)
              : yield* Effect.andThen(
                  rejectReminderFields(draft),
                  googleTasks.createTask(createParams),
                );
          if (source.status === 'completed') {
            const complete = {
              accountId: created.accountId,
              status: 'completed' as const,
              taskId: created.id,
              taskListId: created.listId,
            };
            yield* provider === 'apple'
              ? reminders.completeTask(complete)
              : googleTasks.completeTask(complete);
            return { ...created, status: 'completed' as const };
          }
          return created;
        });
      const deleteSource = { accountId, taskId, taskListId };
      const deleteFrom = (provider: 'apple' | 'google') =>
        provider === 'apple'
          ? reminders.deleteTask(deleteSource)
          : googleTasks.deleteTask(deleteSource);
      // Google → Google: both queue writes in one transaction.
      if (sourceProvider === 'google' && targetProvider === 'google') {
        return yield* transactional(Effect.tap(createIn('google'), () => deleteFrom('google')));
      }
      if (targetProvider === 'google') {
        const created = yield* transactional(createIn('google'));
        yield* deleteFrom('apple');
        return created;
      }
      const created = yield* createIn('apple');
      yield* transactional(deleteFrom('google'));
      return created;
    });

  /** Events dispatch like tasks: by the account's provider. */
  const byProvider =
    <P extends { readonly accountId: string }, A, E1, E2>(
      onApple: (params: P) => Effect.Effect<A, E1>,
      onGoogle: (params: P) => Effect.Effect<A, E2>,
    ) =>
    (params: P): Effect.Effect<A, E1 | E2 | SqlError> =>
      Effect.flatMap(providerOf(params.accountId), (provider): Effect.Effect<A, E1 | E2> =>
        provider === 'apple' ? onApple(params) : onGoogle(params),
      );

  return {
    ...shape,
    createEvent: byProvider(apple.createEvent, google.createEvent),
    deleteEvent: byProvider(apple.deleteEvent, google.deleteEvent),
    deleteRecurring: byProvider(apple.deleteRecurring, google.deleteRecurring),
    moveEvent,
    moveTask,
    previewMove,
    respondToEvent: byProvider(apple.respondToEvent, google.respondToEvent),
    setCalendarColor: byProvider(apple.setCalendarColor, google.setCalendarColor),
    updateEvent: byProvider(apple.updateEvent, google.updateEvent),
    updateRecurring: byProvider(apple.updateRecurring, google.updateRecurring),
  };
});

export class EventMutations extends Context.Service<EventMutations, EventMutationsShape>()(
  'sync/EventMutations',
) {
  static readonly layer: Layer.Layer<
    EventMutations,
    never,
    | AccountRepo
    | AppleCalendarClient
    | AppleCalendarEvents
    | CalendarRepo
    | EventRepo
    | GoogleCalendarClient
    | GoogleTasksClient
    | PendingOpRepo
    | Reactivity
    | RemindersClient
    | SqlClient
    | TaskRepo
  > = Layer.effect(EventMutations)(make);
}
