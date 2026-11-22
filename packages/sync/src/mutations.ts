import {
  AppleCalendarClient,
  mapAppleEvent,
  type AppleCalendarClientShape,
} from '@calendar/apple-calendar';
import {
  appendLink,
  applyWallClockDelta,
  Attendee,
  canonicalReminders,
  canSplitRecurrence,
  type ConvertEventToTaskParams,
  type ConvertTaskToEventParams,
  type CopySource,
  type EventDraft,
  EventRecord,
  EventReminders,
  eventToTaskLoss,
  googleInstanceId,
  isCalendarWritable,
  isRecurringSet,
  isServerMove,
  mergeAttendees,
  meetingUrl,
  type MoveEventParams,
  moveLoss,
  type MoveTaskParams,
  normalizeHexColor,
  PendingOp,
  type PreviewEventToTaskParams,
  type PreviewMoveTaskParams,
  remainingRecurrence,
  type TaskAddressParams,
  taskMoveLoss,
  TaskRecord,
  taskRecurrenceFromLines,
  taskToEventLoss,
  toZonedDateTime,
  type ReminderOverride,
  toRRuleLines,
  recurrenceMasterOf,
  retimedRecurrence,
  toStructuredRules,
  truncateRecurrence,
  withConsistentGeo,
  projectInstance,
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
import { Reactivity } from 'effect/reactivity/Reactivity';
import { SqlClient } from 'effect/sql/SqlClient';
import type { SqlError } from 'effect/sql/SqlError';
import { type AppleCopySource, isPulledCopy, makeApplyOp, retargetOp } from './applyOp.ts';
import { makeHeldEvents } from './heldEvents.ts';
import { AppleCalendarEvents, deviceTimeZone } from './appleCalendarEvents.ts';
import { makeAppleEventMutations } from './appleEventMutations.ts';
import { countAppleChangedOccurrences, findAppleOccurrence } from './appleOccurrence.ts';
import {
  carriedFields,
  planCarry,
  restoreCarriedChanges,
  restoreCarriedText,
  withOwnText,
} from './carriedText.ts';
import {
  CALENDAR_COLOR_EVENT_ID,
  CalendarNotWritableError,
  ConflictNotResolvableError,
  EventAlreadyThereError,
  EventNotFoundError,
  type EventMutationsShape,
  InvalidColorError,
  NotAttendeeError,
  NotOrganizerError,
  RecurringAllDayMoveError,
  RecurringAllDaySwitchError,
  RecurringEditUnsupportedError,
  RecurringSplitUnsupportedError,
  retryDelayMs,
  TaskNotFoundError,
  UnsupportedForProviderError,
  type UpdateEventParams,
  type UpdateRecurringParams,
} from './mutationTypes.ts';
import { makeReminderMutations } from './reminderMutations.ts';
import { dropSplitSeries, holdsSplit, releaseSplits, waitingSplits } from './splitSeries.ts';
import {
  drawsSlot,
  dropSeriesExceptions,
  restoreDropped,
  restoreTaken,
  takeBackDropped,
  takeBackPulled,
  takeIntoDelete,
  takenExceptions,
} from './takenExceptions.ts';
import { cancelledOverrideTombstone } from './tombstone.ts';
import { makeTaskMutations } from './taskMutations.ts';

export * from './mutationTypes.ts';

const isoDate = (epochMs: number): string => new Date(epochMs).toISOString().slice(0, 10);

/**
 * An edit of an event Google has not seen yet rides in its unsent create
 * (`unsentCreateOf`): patching it would 404, and the NotFound arm would
 * delete the local row. The create keeps its createdAt, but re-enqueuing
 * gives it a new rowid, behind occurrence edits sharing that timestamp
 * (a move gives the whole series one timestamp). They still wait for
 * the create regardless of its queue position (applyOp).
 */
const foldIntoCreate = (create: PendingOp, payload: EventRecord) =>
  new PendingOp({
    accountId: create.accountId,
    attempts: 0,
    calendarId: create.calendarId,
    copySource: create.copySource,
    createdAt: create.createdAt,
    eventId: create.eventId,
    id: generateEventId(),
    kind: 'create',
    nextAttemptAt: 0,
    payload,
    splitAt: create.splitAt,
    splitCheck: create.splitCheck,
    splitIn: create.splitIn,
    splitOf: create.splitOf,
  });

/**
 * Google's copy of the event for a new update or delete of it: what it
 * diffs against and a discard puts back. The copy the queued update or
 * delete it replaces reads — the last state Google acknowledged or a
 * pull brought, also when edits pile up offline — else the row as it is
 * now (`null` when there is none: an occurrence edit materializing its
 * override). The repo keeps one copy per event, so this only matters
 * for the first op to hold it. A synced row at a replaced delete's id is
 * Google's copy put back while that delete waited (`isPulledCopy`) and
 * is taken instead.
 */
const inheritedBefore = (
  queued: ReadonlyArray<PendingOp>,
  current: EventRecord | null | undefined,
): PendingOp['beforePayload'] => {
  if (isPulledCopy(queued, current)) {
    return current;
  }
  const prior = queued.find((op) => op.kind === 'update' || op.kind === 'delete');
  return prior ? prior.beforePayload : (current ?? null);
};

/**
 * The park of the queued change a new edit or delete replaces: one made
 * while a change of the event waits for the user's choice waits for it
 * too. The row carries Google's etag by then — it is Google's version
 * with the user's fields over it — so sent on that etag the new change
 * went through and overwrote, unasked, what the two clashed over.
 */
const inheritedPark = (
  queued: ReadonlyArray<PendingOp>,
): { readonly conflictAt?: number; readonly lastError?: string } => {
  const parked = queued.find(
    (op) => (op.kind === 'update' || op.kind === 'delete') && op.conflictAt !== undefined,
  );
  return parked?.conflictAt === undefined
    ? {}
    : { conflictAt: parked.conflictAt, lastError: parked.lastError ?? 'changed on Google' };
};

/**
 * The fields the queued update a new update takes over from named as its
 * own: they stay the new one's, whatever their value is by now. A rename
 * back to the old title while the rename is out differs from nothing here,
 * and left out, it was never sent.
 */
const inheritedChanged = (queued: ReadonlyArray<PendingOp>): ReadonlyArray<string> | undefined => {
  const names = [
    ...new Set(queued.flatMap((op) => (op.kind === 'update' ? (op.changed ?? []) : []))),
  ];
  return names.length > 0 ? names : undefined;
};

/**
 * Per exception, the text fields its queued changes among `behind` set
 * themselves and this edit of the series leaves alone (`planCarry`): the
 * series' queued text is not carried over them again. A field the edit
 * sets now (`sets`) is the series' from here on, as on Google.
 */
const ownedText = (
  behind: ReadonlyArray<PendingOp>,
  sets: ReadonlyArray<string>,
): ReadonlyMap<string, ReadonlySet<string>> => {
  const owned = new Map<string, Set<string>>();
  for (const op of behind) {
    if (op.kind === 'update') {
      owned.set(
        op.eventId,
        new Set([
          ...(owned.get(op.eventId) ?? []),
          ...(op.changed ?? []).filter((name) => !sets.includes(name)),
        ]),
      );
    }
  }
  return owned;
};

/**
 * Whether a series edit changes which slots the series draws: a new rule
 * (or none), or a new start. Google then cancels every exception whose
 * slot is no longer drawn and keeps the others as they are, for new times
 * as for a new rule (verified live 2026-11-22: a series moved an hour
 * loses them all, one whose end alone moved keeps them).
 */
const redraws = (
  changes: UpdateEventParams['changes'],
  master: EventRecord,
  merged: EventRecord,
): boolean => changes.recurrence !== undefined || merged.startUtc !== master.startUtc;

/**
 * The exceptions a series update holds off the table (`beforeOverrides`):
 * the ones the queued update it takes over from held, and the ones it
 * drops itself.
 */
const heldWith = (
  queued: PendingOp | undefined,
  taken: ReadonlyArray<EventRecord>,
): ReadonlyArray<EventRecord> | undefined => {
  const ids = new Set(taken.map((copy) => copy.id));
  const held = [
    ...(queued?.kind === 'update' ? (queued.beforeOverrides ?? []) : []).filter(
      (copy) => !ids.has(copy.id),
    ),
    ...taken,
  ];
  return held.length > 0 ? held : undefined;
};

/** The text of a series that Google copies onto its exceptions when it changes. */
const TEXT_FIELDS = ['description', 'location', 'title'] as const;

/**
 * When a new update of the event is queued: now, and not before an op of
 * it that is queued already. A move re-queues what waited for its event a
 * millisecond after itself, and an edit made in that same millisecond
 * sorted ahead of the change it was made on.
 */
const notBefore = (queued: ReadonlyArray<PendingOp>, now: number): number =>
  Math.max(now, ...queued.map((op) => op.createdAt));

/**
 * The queued series edits whose text the exceptions show locally, in queue
 * order.
 */
const seriesEditsOf = (queued: ReadonlyArray<PendingOp>): ReadonlyArray<PendingOp> =>
  queued.filter((op) => op.kind === 'update' && op.carriedText !== undefined);

/** `before` as Google has it: the queued series edits' carried text taken out, the last first. */
const ownTextOf = <Row extends EventRecord | null | undefined>(
  before: Row,
  seriesEdits: ReadonlyArray<PendingOp>,
): Row => (before ? (seriesEdits.reduceRight<EventRecord>(withOwnText, before) as Row) : before);

/** Whether this edit — or a still-queued update it replaces — touched the guest list. */
const attendeesFlag = (
  changes: UpdateEventParams['changes'],
  queued: ReadonlyArray<PendingOp>,
): true | undefined =>
  changes.attendees !== undefined || queued.some((op) => op.attendeesChanged === true)
    ? true
    : undefined;

/** The patch must send an empty rule list: this edit (or a queued one it replaces) cleared it. */
const recurrenceClearedFlag = (
  changes: UpdateEventParams['changes'],
  queued: ReadonlyArray<PendingOp>,
): true | undefined =>
  changes.recurrence === null || queued.some((op) => op.recurrenceCleared === true)
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

/**
 * The defined fields of an update, ready to spread over an EventRecord.
 * `attendees` is the editor's replacement list and is merged against the
 * current guests so server facts (responses, organizer) survive.
 */
const definedChanges = (
  changes: UpdateEventParams['changes'],
  currentAttendees: EventRecord['attendees'],
): Partial<EventRecord> => {
  // The rule is never spread onto a row: each scope handles it itself.
  const { attendees, geo, recurrence: _recurrence, reminders, ...rest } = changes;
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

/** Which event: the source of a move or a conversion. */
type EventRef = Pick<MoveEventParams, 'accountId' | 'calendarId' | 'eventId'>;

/** The op kinds that queue a copy toward Google, and those that delete its source there. */
const COPY_KINDS: ReadonlySet<PendingOp['kind']> = new Set(['create', 'createTask']);
const DELETE_KINDS: ReadonlySet<PendingOp['kind']> = new Set(['delete', 'deleteTask']);

/**
 * A move's or a conversion's source (`crossStore`): where it sits — its
 * account, calendar or list, and id — and, for an Apple one, the item as
 * it was (`kept`), made again if its copy toward Google does not land.
 */
interface CopyFrom {
  readonly accountId: string;
  readonly containerId: string;
  readonly id: string;
  readonly kept: AppleCopySource | undefined;
}

/** A task as the source of a move or a conversion. */
const taskFrom = (task: TaskRecord, provider: 'apple' | 'google'): CopyFrom => ({
  accountId: task.accountId,
  containerId: task.listId,
  id: task.id,
  kept: provider === 'apple' ? { kind: 'reminder', task } : undefined,
});

interface MoveSource {
  /** Google only: what the master's `useDefault` resolves to on its calendar. */
  readonly defaultReminders: ReadonlyArray<ReminderOverride> | undefined;
  /**
   * The event as a series master (occurrence ids and slots stripped) —
   * or, for a conversion of one occurrence, that occurrence as it is
   * drawn, without the series' rule.
   */
  readonly master: EventRecord;
  /**
   * Occurrences changed on their own, which a copy drops. An Apple
   * series' are counted only for a preview (a range read); 0 otherwise.
   */
  readonly modifiedOccurrences: number;
  /** Apple only: the event's URL (non-meeting URLs are not on the record). */
  readonly url: string | undefined;
}

/** An event (the series, or one occurrence) as the source of a move or a conversion. */
const eventFrom = (
  params: EventRef,
  provider: 'apple' | 'google',
  source: MoveSource,
): CopyFrom => ({
  accountId: params.accountId,
  containerId: params.calendarId,
  id: params.eventId,
  kept:
    provider === 'apple'
      ? {
          event: source.master,
          kind: 'appleEvent',
          ...(source.url === undefined ? {} : { url: source.url }),
        }
      : undefined,
});

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
    description = appendLink(description, source.url ?? master.hangoutLink, master.location);
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

/** What a series or "following" edit has settled before it writes (see updateRecurring). */
interface SettledSeriesEdit {
  readonly defined: Partial<EventRecord>;
  readonly duration: number;
  readonly master: EventRecord;
  readonly now: number;
  readonly unsentCreate: PendingOp | undefined;
}

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

  /** One account's queued ops of an event: a shared calendar repeats its ids under every account. */
  const opsForEvent = (accountId: string, calendarId: string, eventId: string) =>
    pendingOpRepo.listForEvent({ accountId, calendarId, eventId });

  const enqueue = (op: PendingOp) => pendingOpRepo.enqueue(op);

  /**
   * The queued create of an event, while it was never sent (no dispatch
   * stamp, applyOp): only then is Google sure not to have the event, so an
   * edit may fold into it and a delete may simply drop it. A sent create
   * may have landed with its response lost — its retry answers 409, which
   * counts as done without sending a folded edit — so edits and deletes
   * queue behind it instead (`supersedeQueued`).
   */
  const unsentCreateOf = (accountId: string, calendarId: string, eventId: string) =>
    Effect.map(opsForEvent(accountId, calendarId, eventId), (ops) =>
      ops.find((op) => op.kind === 'create' && op.dispatchedAt === undefined),
    );

  /**
   * Drops the queued ops a new edit or delete of the event replaces — all
   * but a sent create, which stays ahead of it (applyOp holds the new op
   * until the create is done). RSVPs and moves stay, as in removeForEvent.
   */
  const supersedeQueued = (accountId: string, calendarId: string, eventId: string) =>
    Effect.gen(function* () {
      const queued = yield* opsForEvent(accountId, calendarId, eventId);
      if (!queued.some((op) => op.kind === 'create')) {
        return yield* pendingOpRepo.removeForEvent(accountId, calendarId, eventId);
      }
      for (const op of queued) {
        if (op.kind === 'update' || op.kind === 'delete') {
          yield* pendingOpRepo.remove(op.id);
        }
      }
    });

  /**
   * The queued update of the event, which a new edit of it takes over from
   * and whose place in the queue it takes (`pendingOpRepo.enqueue`): an
   * event has one waiting update at most, holding everything the user
   * changed since Google last answered. `behind` are the queued changes of
   * the series' occurrences made under it; they stay behind it. (Replaced
   * at the back of the queue, the update went behind them: a delete of an
   * occurrence only its new rule draws met a 404 and counted as done, and
   * the day came back with the rule.) A queued delete of the event leaves:
   * the edit keeps the event.
   */
  const queuedUpdate = (
    event: { readonly accountId: string; readonly calendarId: string; readonly eventId: string },
    queued: ReadonlyArray<PendingOp>,
  ) =>
    Effect.gen(function* () {
      for (const op of queued) {
        if (op.kind === 'delete') {
          yield* pendingOpRepo.remove(op.id);
        }
      }
      const replaced = queued.findLast((op) => op.kind === 'update');
      if (!replaced) {
        return { behind: [], replaced };
      }
      const all = yield* pendingOpRepo.listAll();
      const behind = all
        .slice(all.findIndex((op) => op.id === replaced.id) + 1)
        .filter(
          (op) =>
            op.accountId === event.accountId &&
            op.calendarId === event.calendarId &&
            op.eventId.startsWith(`${event.eventId}_`),
        );
      return { behind, replaced };
    });

  /**
   * The series' text wins over an occurrence's own where this edit sets
   * it: Google copies a changed title, description or location onto every
   * exception (verified live), so a change of an occurrence queued behind
   * the series' takes the new text in the fields it had set itself, as its
   * row does (`planCarry`).
   */
  const carryOntoQueued = (
    behind: ReadonlyArray<PendingOp>,
    merged: EventRecord,
    sets: ReadonlyArray<(typeof TEXT_FIELDS)[number]>,
  ) =>
    Effect.gen(function* () {
      for (const op of behind) {
        const mine = sets.filter((field) => op.changed?.includes(field) === true);
        if (op.kind !== 'update' || !op.payload || mine.length === 0) {
          continue;
        }
        yield* pendingOpRepo.setPayload(
          op.id,
          withConsistentGeo(
            new EventRecord({
              ...op.payload,
              ...Object.fromEntries(mine.map((field) => [field, merged[field]])),
            }),
          ),
        );
      }
    });

  const taken = { eventRepo, pendingOpRepo };
  const heldEvents = makeHeldEvents(taken);

  /**
   * A change of the series made while its delete is still queued replaces
   * that delete: the exceptions it took off the table come back first, as
   * Google has them, so the change sees the series as Google does — a
   * move, an answer, an edit, or what a new delete takes
   * (takenExceptions.ts).
   */
  const restoreTakenExceptions = (accountId: string, calendarId: string, masterId: string) =>
    restoreTaken(taken, accountId, calendarId, masterId);

  /**
   * What an occurrence edit or delete starts from: the occurrence's row,
   * else the exception a queued series delete took there — Google still
   * has it while that delete waits, and the master may be on the table
   * again (keep-theirs on another change of it). Built on the master's
   * slot instead, the edit would patch the exception's own changes away
   * and the delete would remember nothing to put back. The series delete
   * stays queued, so nothing else it took comes back. A cancellation it
   * took is no base: the slot shows, and the change starts from it as
   * before.
   */
  const occurrenceRow = (
    accountId: string,
    calendarId: string,
    masterId: string,
    instanceId: string,
  ) =>
    Effect.gen(function* () {
      const row = yield* eventRepo.getById(accountId, calendarId, instanceId);
      if (row) {
        return row;
      }
      const exceptions = yield* takenExceptions(pendingOpRepo, accountId, calendarId, masterId);
      return (
        exceptions.find(
          (override) => override.id === instanceId && override.status !== 'cancelled',
        ) ?? null
      );
    });

  /**
   * Queues a this-and-following truncation of the master: a patch, or its
   * unsent create. The patch drops the exceptions from the cut on.
   */
  const truncateQueued = (
    accountId: string,
    calendarId: string,
    master: EventRecord,
    truncated: EventRecord,
    unsentCreate: PendingOp | undefined,
    now: number,
    cutAt: number,
    taken: ReadonlyArray<EventRecord>,
  ) =>
    Effect.gen(function* () {
      const queued = yield* opsForEvent(accountId, calendarId, master.id);
      if (unsentCreate) {
        yield* pendingOpRepo.removeForEvent(accountId, calendarId, master.id);
        return yield* pendingOpRepo.enqueue(foldIntoCreate(unsentCreate, truncated));
      }
      const { replaced } = yield* queuedUpdate(
        { accountId, calendarId, eventId: master.id },
        queued,
      );
      yield* pendingOpRepo.enqueue(
        new PendingOp({
          accountId,
          attempts: 0,
          // What the series edit it takes over from changed still goes:
          // guests, reminders and dropped coordinates ride on flags.
          attendeesChanged: attendeesFlag({}, queued),
          ...inheritedPark(queued),
          baseEtag: master.etag ?? undefined,
          // The exceptions from the cut on, which Google cancels with it.
          beforeOverrides: heldWith(replaced, taken),
          beforePayload: inheritedBefore(queued, master),
          calendarId,
          // The carried text of the series edit it takes over from: its
          // payload still shows that edit's text, so abandoning it must
          // still undo the carry.
          carriedText: replaced?.carriedText,
          changed: inheritedChanged(queued),
          createdAt: notBefore(queued, now),
          dropsFrom: Math.min(cutAt, replaced?.dropsFrom ?? cutAt),
          eventId: master.id,
          geoCleared: geoClearedFlag(master, truncated, queued),
          id: generateEventId(),
          kind: 'update',
          nextAttemptAt: 0,
          payload: truncated,
          remindersChanged: remindersFlag({}, queued),
        }),
        replaced?.id,
      );
    });

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

  const queuedIds = Effect.map(pendingOpRepo.listAll(), (ops) => new Set(ops.map((op) => op.id)));
  /** The ops of `kinds` queued since `before` was read, in queue order. */
  const queuedSince = (before: ReadonlySet<string>, kinds: ReadonlySet<PendingOp['kind']>) =>
    Effect.map(pendingOpRepo.listAll(), (ops) =>
      ops.filter((op) => !before.has(op.id) && kinds.has(op.kind)),
    );

  /**
   * Copy, then delete, across two stores — a move or a conversion. A
   * failure between the two leaves a duplicate, never nothing. Toward
   * Apple the EventKit create comes first and the queued delete is
   * transactional. Toward Google the copy is only queued, and Google can
   * still turn it down, so the source outlasts it (`copySource`): a
   * Google source's deletes are queued in the same transaction and held
   * until the copy lands (applyOp copyGate); an Apple source is deleted
   * from EventKit once the copy is queued and kept on it as it was, to be
   * made again (applyOp releaseCopySource) — unless that delete failed,
   * and the source is still there. A Google source that is itself a copy
   * not yet sent hands what it came from on to the new copy.
   */
  const crossStore = <A, E1, E2, R1, R2>(
    route: { readonly source: 'apple' | 'google'; readonly target: 'apple' | 'google' },
    from: CopyFrom,
    create: Effect.Effect<A, E1, R1>,
    remove: Effect.Effect<unknown, E2, R2>,
  ): Effect.Effect<A, E1 | E2 | SqlError, R1 | R2> => {
    if (route.target === 'apple') {
      return Effect.tap(create, () => transactional(remove));
    }
    if (route.source === 'google') {
      return transactional(
        Effect.gen(function* () {
          const before = yield* queuedIds;
          const own = (yield* pendingOpRepo.listForEvent({
            accountId: from.accountId,
            calendarId: from.containerId,
            eventId: from.id,
          })).filter((op) => COPY_KINDS.has(op.kind) && op.copySource !== undefined);
          const created = yield* create;
          const copies = yield* queuedSince(before, COPY_KINDS);
          yield* remove;
          const deletes = yield* queuedSince(before, DELETE_KINDS);
          const after = yield* queuedIds;
          const source: CopySource | undefined =
            deletes.length > 0
              ? { kind: 'held', opIds: deletes.map((op) => op.id) }
              : own.find((op) => !after.has(op.id))?.copySource;
          if (source) {
            yield* pendingOpRepo.setCopySource(
              copies.map((op) => op.id),
              source,
            );
          }
          return created;
        }),
      );
    }
    // The drain waits until EventKit answered — its gate is held, since a
    // kick from elsewhere or a sync pass would send the copy too: one Google
    // turned down at once made the source again before its delete ran, and
    // a delete that then failed left two of it.
    return gate
      .withPermits(1)(
        Effect.gen(function* () {
          const { copy, created } = yield* sql.withTransaction(
            Effect.gen(function* () {
              const before = yield* queuedIds;
              const created = yield* create;
              // The item's own create; a completion queued behind it is no copy.
              const [copy] = yield* queuedSince(before, COPY_KINDS);
              if (copy && from.kept) {
                yield* pendingOpRepo.setCopySource([copy.id], from.kept);
              }
              return { copy, created };
            }),
          );
          yield* Effect.tapError(remove, () =>
            copy ? Effect.ignore(pendingOpRepo.setCopySource([copy.id], undefined)) : Effect.void,
          );
          return created;
        }),
      )
      .pipe(Effect.ensuring(kick));
  };

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

  /**
   * Drops override rows at/after the split, except those `keeps` names:
   * Google cancels them with the series update that redraws the series,
   * so nothing is queued for them. Returns Google's copies of them
   * (`taken`), which that update holds until it lands or is given up —
   * none if the series never reached Google (`remote: false`) — and the
   * deletes the user made of such occurrences themselves (`deletes`), for
   * the caller to queue behind the update.
   */
  const dropOverridesFrom = (
    accountId: string,
    calendarId: string,
    masterId: string,
    fromOriginalStartUtc: number,
    now: number,
    {
      keeps = () => false,
      remote,
    }: { readonly keeps?: (override: EventRecord) => boolean; readonly remote: boolean },
  ) =>
    Effect.gen(function* () {
      const deletes: Array<PendingOp> = [];
      const taken: Array<EventRecord> = [];
      const overrides = yield* eventRepo.listOverrides(accountId, calendarId, masterId);
      // A queued series edit carried its text onto the exceptions locally;
      // what Google has is their own text.
      const seriesEdits = seriesEditsOf(yield* opsForEvent(accountId, calendarId, masterId));
      for (const override of overrides) {
        if (
          (override.originalStartUtc ?? override.startUtc) < fromOriginalStartUtc ||
          keeps(override)
        ) {
          continue;
        }
        const queued = yield* opsForEvent(accountId, calendarId, override.id);
        // An occurrence the user deleted keeps its own delete and tombstone
        // (folded into the change, it went with a discard of the change),
        // queued behind the change: ahead, it went out first, and a 412's
        // keep-theirs showed the occurrence past the cut. A park goes too:
        // the change's landing settles it, and abandoned, the delete meets
        // that 412 again.
        const own = queued.find((op) => op.kind === 'delete');
        if (remote && own && override.status === 'cancelled' && override.syncStatus === 'pending') {
          yield* pendingOpRepo.remove(own.id);
          deletes.push(
            new PendingOp({
              ...own,
              attempts: 0,
              conflictAt: undefined,
              createdAt: now,
              id: generateEventId(),
              lastError: undefined,
              nextAttemptAt: 0,
            }),
          );
          continue;
        }
        // What giving the change up puts back: the exception as Google has
        // it, not an offline edit of it whose op goes with it here; none
        // for one this device only materialized.
        const holder = queued.find(
          (op) => op.kind === 'delete' || op.kind === 'rsvp' || op.kind === 'update',
        );
        const acked = ownTextOf(
          holder === undefined || isPulledCopy(queued, override) ? override : holder.beforePayload,
          seriesEdits,
        );
        yield* pendingOpRepo.removeForEvent(accountId, calendarId, override.id);
        yield* eventRepo.deleteEvent(accountId, calendarId, override.id);
        if (remote && acked) {
          taken.push(acked);
        }
      }
      return { deletes, taken };
    });

  const {
    acknowledge,
    apply: applyOp,
    dropUndrawn,
    releaseAccountCopies,
    releaseRow,
    settleDiscardedMove,
  } = makeApplyOp({
    accountRepo,
    calendarRepo,
    client,
    eventRepo,
    notifyDropped: Effect.ignore(reactivity.invalidate([DROPPED_NOTICE_KEY])),
    pendingOpRepo,
    // Defined with the moves below; only a drain long after setup calls it.
    restoreCopySource: (source) => Effect.suspend(() => restoreSource(source)),
    taskRepo,
    tasksClient,
    transaction: sql.withTransaction,
  });

  /**
   * A copy landed, so the source deletes it held may go now. One may wait
   * behind the sent create of an earlier copy — the item was moved on
   * before that create was answered: this copy landing settles the move,
   * so that create no longer puts its own source back if it then fails
   * (two of it), and the source deletes it held go too.
   */
  const settleHeld = (opIds: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      for (const opId of opIds) {
        const held = yield* pendingOpRepo.getById(opId);
        if (!held) {
          continue;
        }
        const earlier = (yield* pendingOpRepo.listForEvent({
          accountId: held.accountId,
          calendarId: held.calendarId,
          eventId: held.eventId,
        })).filter((other) => COPY_KINDS.has(other.kind) && other.copySource !== undefined);
        yield* pendingOpRepo.setCopySource(
          earlier.map((other) => other.id),
          undefined,
        );
        for (const other of earlier) {
          if (other.copySource?.kind === 'held') {
            for (const sourceDelete of other.copySource.opIds) {
              yield* pendingOpRepo.makeDue(sourceDelete);
            }
          }
        }
        yield* pendingOpRepo.makeDue(opId);
      }
    });

  /**
   * An op left the queue: what stood back for it (an occurrence's change
   * behind its series', a later change of the event behind this one) goes
   * with the next drain, not once its backoff is over.
   */
  const wake = (op: PendingOp) =>
    Effect.flatMap(pendingOpRepo.wakeWaiting(op), (woken) => (woken > 0 ? kick : Effect.void));

  /** An op is done: it leaves the queue, and what waited for it may go. */
  const finish = (op: PendingOp) =>
    Effect.gen(function* () {
      yield* pendingOpRepo.remove(op.id);
      yield* wake(op);
      // The source deletes this copy held may go now (applyOp
      // copyGate); a copy that did not land took them back.
      if (op.copySource?.kind === 'held') {
        yield* settleHeld(op.copySource.opIds);
      }
      // A series split off this one waits for it no more (splitSeries.ts).
      if (holdsSplit(op)) {
        yield* releaseSplits(taken, op);
      }
    });

  const landedInPull: EventMutationsShape['landedInPull'] = (landed) =>
    Effect.ignore(
      Effect.forEach(
        landed,
        ({ opId, record }) =>
          Effect.gen(function* () {
            // Re-read: an earlier one of the page may have settled it.
            const op = yield* pendingOpRepo.getById(opId);
            if (op && (yield* acknowledge(op, record))) {
              yield* finish(op);
            }
          }),
        { discard: true },
      ),
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
            // than send what they took back.
            const op = yield* pendingOpRepo.getById(queuedOp.id);
            if (!op) {
              continue;
            }
            // Given up, and its discard still to finish (it waits for this
            // gate, or the app stopped before it could): never sent.
            if (op.discarded === true && op.kind !== 'move' && op.kind !== 'moveTask') {
              yield* finishDiscard(op.id);
              continue;
            }
            const outcome = yield* applyOp(op);
            if (outcome === 'done') {
              yield* finish(op);
            } else if ('conflict' in outcome) {
              // Parked until the user chooses (resolveConflict), with the
              // user's version on screen. Google's is the event's copy
              // from here on; none, when Google has the event no more.
              yield* pendingOpRepo.setBefore(op.id, outcome.conflict);
              yield* pendingOpRepo.markConflict(op.id, now);
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

  /**
   * Whether the discard of this change asks Google first: an event's
   * update, delete or answer that was tried before. Its request may have
   * landed with the answer lost. Put back as "never sent", a cut, a new
   * rule or a delete that had landed left occurrences, or an event, on
   * screen that Google has no more, and a change made to one was refused
   * and dropped. Not one that waits for the user's choice (that has its
   * own answers), nor one behind a move or a create, where Google has
   * nothing to ask about yet, nor one of an occurrence Google held no
   * exception for: asked by its id, Google answers with the series drawn
   * at that slot, which cannot be told from an exception and is nothing
   * to store (kept as a row, it stood still when the series changed).
   * Such a change goes back as never sent, and the next pull brings what
   * it made if it had landed.
   */
  const asksGoogleOnDiscard = (op: PendingOp) =>
    op.attempts > 0 &&
    op.conflictAt === undefined &&
    op.copySource === undefined &&
    op.beforePayload != null &&
    (op.kind === 'delete' || op.kind === 'rsvp' || op.kind === 'update')
      ? Effect.map(
          pendingOpRepo.earlierInSeries(op),
          (earlier) => !earlier.some((entry) => entry.kind === 'move' || entry.kind === 'create'),
        )
      : Effect.succeed(false);

  /**
   * Finishes the discard of a change marked given up (`PendingOp.discarded`),
   * with no request of it out (under the drain's gate): Google says what it
   * has, and that is what shows, as take-theirs does, whether the change
   * had landed or not. When Google cannot be reached the change is put
   * back as never sent, as the user asked, and the next pull corrects it
   * if it had landed (todo.md, Tier 0).
   */
  const finishDiscard = (opId: string) =>
    Effect.gen(function* () {
      const op = yield* pendingOpRepo.getById(opId);
      // Landed, or settled otherwise, while this waited: nothing to undo.
      if (!op) {
        return;
      }
      // Any failure but "gone" is no answer, a defect of the client's
      // included: the discard itself must not fail for it.
      const answer = yield* client
        .getEvent({ accountId: op.accountId, calendarId: op.calendarId, eventId: op.eventId })
        .pipe(
          Effect.map((item): { readonly item: GcalEvent | undefined } | undefined => ({ item })),
          Effect.catchTags({
            NotFoundError: () => Effect.succeed({ item: undefined }),
            SyncTokenExpiredError: () => Effect.succeed({ item: undefined }),
          }),
          Effect.catchCause(() => Effect.succeed(undefined)),
        );
      if (answer === undefined) {
        yield* discard(opId);
      } else {
        const now = yield* Clock.currentTimeMillis;
        yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* takeTheirs(op, answer.item, now);
            yield* dropUndrawn(op);
          }),
        );
      }
      yield* wake(op);
    });

  /**
   * A move's discard sends what was queued after it back to the source,
   * reading its place in the queue, so the move goes only once released.
   * One never sent goes at once (the drain stamps a move as sent in one
   * transaction with checking it is still queued). One that was sent may
   * have been made, its answer lost or its request still out: under the
   * drain's gate — taken outside the transaction, since the drain writes
   * while holding it — Google is asked first (settleDiscardedMove). A cut
   * a split-off series waits for goes at once too: that series asks Google
   * before it goes (splitSeries.ts), so the drain runs now.
   */
  const discardPendingOp: EventMutationsShape['discardPendingOp'] = (opId) =>
    Effect.gen(function* () {
      const queued = yield* pendingOpRepo.getById(opId);
      if (queued && (yield* asksGoogleOnDiscard(queued))) {
        // Marked at once, so a drain already running does not send it
        // while this waits for the gate; the drain finishes the discard
        // itself if the app stops in between.
        yield* pendingOpRepo.markDiscarded(opId, 'discarded');
        yield* gate.withPermits(1)(Effect.orDie(finishDiscard(opId)));
        return yield* kick;
      }
      const splits = queued !== undefined && (yield* waitingSplits(taken, queued));
      // A copy's discard puts its source back: under the drain's gate, so
      // a refusal the drain is putting back meanwhile cannot do it twice.
      const sent = yield* queued?.copySource === undefined
        ? discard(opId)
        : gate.withPermits(1)(discard(opId));
      if (splits) {
        yield* kick;
      }
      if (queued && !sent) {
        yield* wake(queued);
      }
      if (!sent) {
        return;
      }
      yield* gate.withPermits(1)(
        Effect.gen(function* () {
          // The drain settled it meanwhile (it landed, or was dropped).
          const op = yield* pendingOpRepo.getById(opId);
          if (!op) {
            return;
          }
          if ((yield* settleDiscardedMove(op)) === 'done') {
            yield* pendingOpRepo.remove(opId);
            yield* wake(op);
          } else {
            // Google did not say whether it landed: it stays queued, never
            // sent again, and settles once Google answers.
            yield* pendingOpRepo.markDiscarded(opId, 'given up; asking Google where it is');
          }
        }),
      );
    });

  /** Discards the op; a move that was sent is left queued and returned. */
  const discard = (opId: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        let op = yield* pendingOpRepo.getById(opId);
        // A move (an event's or a task's) is released while still queued:
        // what goes back with it is what was queued behind it. One that
        // was sent may have landed: it stays queued for the caller to ask.
        if (op?.kind === 'move' || op?.kind === 'moveTask') {
          if (op.dispatchedAt !== undefined) {
            // Given up from here on, in this transaction: a drain already
            // running reads it so and only asks Google where the item is.
            // Marked after the wait for its gate, it was sent once more.
            yield* pendingOpRepo.markDiscarded(opId, 'given up; asking Google where it is');
            return op;
          }
          yield* releaseRow(op);
          yield* pendingOpRepo.remove(opId);
          return undefined;
        }
        yield* pendingOpRepo.remove(opId);
        const given = op;
        while (op) {
          // A subtask kept is a parent kept: Google deletes a parent's
          // subtasks with it, so the parent's queued delete goes too. The
          // parent Google has it under, read before its copy is released.
          const parentId =
            op.kind === 'deleteTask'
              ? (yield* taskRepo.findCopy(op.accountId, op.eventId))?.parentId
              : undefined;
          yield* releaseRow(op);
          // The parent's delete, in whatever list it waits: moved since
          // the subtask was deleted, it is queued in the destination, and
          // left there it took the subtask the user kept along on Google.
          const { accountId } = op;
          op =
            parentId === undefined
              ? undefined
              : (yield* pendingOpRepo.listForTask(accountId, parentId)).find(
                  (queued) => queued.kind === 'deleteTask',
                );
          if (op) {
            yield* pendingOpRepo.remove(op.id);
          }
        }
        if (given) {
          yield* dropUndrawn(given);
        }
        return undefined;
      }),
    );

  /**
   * Keep mine: re-send without If-Match. A parked delete also takes any
   * row of Google's still at its id, or of its series' exceptions, back
   * off the table as copies it holds (`takeBackPulled`; a pending row —
   * an instance tombstone — is the user's own and stays). An edit of an
   * event Google deleted is restored as a new event: patching it would 404
   * and the NotFound arm would drop the edit. Of an occurrence Google
   * cancelled, that new event stands on its own and the occurrence stays
   * cancelled in its series.
   */
  const keepMine = (op: PendingOp, now: number) =>
    Effect.gen(function* () {
      if (op.kind === 'delete') {
        yield* takeBackPulled(taken, op);
        return yield* pendingOpRepo.unpark(op.id, now);
      }
      if (op.beforePayload && op.beforePayload.status !== 'cancelled') {
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
      // An occurrence Google holds cancelled stays hidden: its tombstone
      // is Google's copy, and the row. Taken away with the edit, the
      // series drew that day again beside the copy, and no later pull
      // says it is cancelled.
      const tombstone = op.beforePayload;
      yield* tombstone?.status === 'cancelled' && tombstone.recurringEventId !== undefined
        ? eventRepo.upsertMany([new EventRecord({ ...tombstone, syncStatus: 'synced' })])
        : eventRepo.deleteEvent(op.accountId, op.calendarId, op.eventId);
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

  /**
   * Take theirs: Google's current copy (undefined = gone) replaces the
   * local row — an exception's goes into its series delete instead while
   * that waits with the master gone (`takeIntoDelete`). Google kept a
   * series' exceptions with its master: what the change taken back held
   * off the table (a series delete, or a cut, a new rule or new times)
   * comes back, where no row is and Google's series draws it. A series
   * gone on Google took them along, and their synced rows go too.
   */
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
      if (record && (yield* takeIntoDelete(taken, record))) {
        yield* eventRepo.deleteEvent(op.accountId, op.calendarId, op.eventId);
      } else if (record) {
        // Ack mode: overwrites the pending row the pulls skipped.
        yield* eventRepo.upsertMany([record]);
        yield* restoreTaken(taken, op.accountId, op.calendarId, op.eventId);
        yield* restoreDropped(taken, op);
      } else {
        yield* eventRepo.deleteEvent(op.accountId, op.calendarId, op.eventId);
        yield* dropSeriesExceptions(taken, op.accountId, op.calendarId, op.eventId);
      }
      // A cut taken back takes the series a this-and-following edit split
      // off along where Google's master draws its days (splitSeries.ts).
      if (holdsSplit(op)) {
        yield* dropSplitSeries(taken, op, record);
      }
      yield* restoreCarriedText(taken, op);
      yield* pendingOpRepo.remove(op.id);
      // What still waits for the event is laid over Google's version now,
      // and asks in its turn where it changed the same thing.
      if (record && record.status !== 'cancelled') {
        yield* heldEvents.take(record);
      }
    });

  const resolveConflict: EventMutationsShape['resolveConflict'] = ({ choice, opId }) =>
    Effect.gen(function* () {
      const op = yield* pendingOpRepo.getById(opId);
      if (!op || op.conflictAt === undefined) {
        return;
      }
      if (choice === 'mine') {
        // Read again in the transaction: a pull page may have changed what
        // the op holds, which keep-mine adds to. transactional kicks the drain once the
        // unpark committed.
        return yield* transactional(
          Effect.gen(function* () {
            const current = yield* pendingOpRepo.getById(opId);
            if (current?.conflictAt !== undefined) {
              yield* keepMine(current, yield* Clock.currentTimeMillis);
            }
          }),
        );
      }
      // After a move the op points at the destination, where Google has
      // nothing until the move lands; a fetch there would 404 and delete
      // the user's row.
      if ((yield* pendingOpRepo.earlierInSeries(op)).some((entry) => entry.kind === 'move')) {
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
            yield* dropUndrawn(current);
          }
        }),
      );
      yield* wake(op);
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

  /** A task create/delete against one provider's store, outside any transaction (crossStore adds it). */
  const createTaskIn = (
    provider: 'apple' | 'google',
    params: Parameters<EventMutationsShape['createTask']>[0],
  ) =>
    provider === 'apple'
      ? reminders.createTask(params)
      : Effect.andThen(rejectReminderFields(params), googleTasks.createTask(params));
  const deleteTaskFrom = (
    provider: 'apple' | 'google',
    params: Parameters<EventMutationsShape['deleteTask']>[0],
  ) => (provider === 'apple' ? reminders.deleteTask(params) : googleTasks.deleteTask(params));

  const taskMutations: Pick<
    EventMutationsShape,
    'completeTask' | 'createTask' | 'deleteTask' | 'reorderTask' | 'updateTask'
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
    // EventKit keeps no order or subtasks for a reminder.
    reorderTask: (params) =>
      Effect.flatMap(providerOf(params.accountId), (provider) =>
        provider === 'apple'
          ? Effect.fail(new UnsupportedForProviderError({ field: 'position', provider }))
          : transactional(googleTasks.reorderTask(params)),
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

  /** An instance edit: the one occurrence becomes, or stays, an exception of its own. */
  const updateOccurrence = (
    { accountId, calendarId, changes, masterId, originalStartUtc }: UpdateRecurringParams,
    master: EventRecord,
    now: number,
  ) =>
    Effect.gen(function* () {
      // Materialize (or update) the exception under its instance id; the
      // patch on that id creates the exception server-side.
      const instanceId = googleInstanceId(masterId, originalStartUtc, master.isAllDay);
      const existing = yield* occurrenceRow(accountId, calendarId, masterId, instanceId);
      const base = existing ?? projectInstance(master, originalStartUtc, now);
      if (changes.isAllDay !== undefined && changes.isAllDay !== base.isAllDay) {
        return yield* Effect.fail(new RecurringAllDaySwitchError({ eventId: masterId }));
      }
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
      const queued = yield* opsForEvent(accountId, calendarId, instanceId);
      yield* pendingOpRepo.removeForEvent(accountId, calendarId, instanceId);
      yield* enqueue(
        new PendingOp({
          accountId,
          attempts: 0,
          attendeesChanged: attendeesFlag(changes, queued),
          ...inheritedPark(queued),
          baseEtag: existing?.etag ?? undefined,
          // Its own text, not what a queued series edit carried onto it.
          beforePayload: ownTextOf(
            inheritedBefore(queued, existing),
            seriesEditsOf(yield* opsForEvent(accountId, calendarId, masterId)),
          ),
          calendarId,
          changed: inheritedChanged(queued),
          // Never ahead of a change of its series it was made under.
          createdAt: notBefore(yield* opsForEvent(accountId, calendarId, masterId), now),
          eventId: instanceId,
          geoCleared: geoClearedFlag(base, merged, queued),
          id: generateEventId(),
          kind: 'update',
          nextAttemptAt: 0,
          payload: merged,
          remindersChanged: remindersFlag(changes, queued),
        }),
      );
    });

  /**
   * What a series edit that redraws the series does to the exceptions:
   * the ones it holds off the table from here on (`taken`, with what the
   * queued update it takes over from still holds) and the user's own
   * deletes of dropped occurrences to queue behind the PATCH (`deletes`).
   * Nothing new while the series draws the slots it drew.
   */
  const dropUndrawnExceptions = (
    { accountId, calendarId, changes, masterId }: UpdateRecurringParams,
    merged: EventRecord,
    { master, now, unsentCreate }: SettledSeriesEdit,
  ) =>
    Effect.gen(function* () {
      const queued = yield* opsForEvent(accountId, calendarId, masterId);
      const replaced = queued.findLast((op) => op.kind === 'update');
      // A new rule (or none), or new times, cancel the exceptions whose
      // slots the series no longer draws, and keep the others as they are
      // (Google does both with the PATCH, verified live); so do we. What a
      // cut or rule change queued before it dropped comes back where it
      // draws again.
      if (!redraws(changes, master, merged)) {
        return { deletes: [], taken: heldWith(replaced, []) };
      }
      let held: ReadonlyArray<EventRecord> = [];
      if (!unsentCreate) {
        // An exception whose slot Google's own rule no longer draws is
        // one Google cancelled with an earlier cut or rule change (a
        // full pull brings its tombstone): drawn again, that slot is a
        // plain occurrence on Google.
        const onGoogle = inheritedBefore(queued, master);
        for (const override of yield* eventRepo.listOverrides(accountId, calendarId, masterId)) {
          if (override.syncStatus === 'synced' && onGoogle && !drawsSlot(onGoogle, override)) {
            yield* eventRepo.deleteEvent(accountId, calendarId, override.id);
          }
        }
        held = yield* takeBackDropped(taken, merged, replaced);
      }
      const dropped = yield* dropOverridesFrom(accountId, calendarId, masterId, 0, now, {
        keeps: (override) => drawsSlot(merged, override),
        remote: !unsentCreate,
      });
      const ids = new Set(dropped.taken.map((copy) => copy.id));
      return {
        deletes: dropped.deletes,
        taken: [...held.filter((copy) => !ids.has(copy.id)), ...dropped.taken],
      };
    });

  /**
   * A series edit, or a "following" one at or before the first occurrence:
   * the master takes the change, and every occurrence with it.
   */
  const updateSeries = (params: UpdateRecurringParams, settled: SettledSeriesEdit) =>
    Effect.gen(function* () {
      const { accountId, calendarId, changes, masterId, originalStartUtc } = params;
      const { defined, duration, master, now, unsentCreate } = settled;
      // Time edits shift the master (and thus every occurrence) by the
      // occurrence's wall-clock delta — immune to DST offset differences
      // between the occurrence's date and the series start. All-day
      // masters only take non-time fields.
      const zone = master.startTimeZone ?? 'UTC';
      const movedTo = master.isAllDay ? undefined : changes.startUtc;
      const shift =
        movedTo === undefined
          ? undefined
          : (utc: number) => applyWallClockDelta(utc, zone, originalStartUtc, movedTo);
      const startUtc = shift ? shift(master.startUtc) : master.startUtc;
      // A date-time UNTIL is read against the moved occurrences, or a
      // cut's would draw the split day (`retimedRecurrence`). A new rule
      // from the edit is taken as given.
      const recurrence =
        changes.recurrence !== undefined
          ? (changes.recurrence ?? undefined)
          : shift && master.recurrence
            ? retimedRecurrence(recurrenceMasterOf(master), startUtc, shift)
            : master.recurrence;
      const merged = withConsistentGeo(
        new EventRecord({
          ...master,
          attendees: defined.attendees ?? master.attendees,
          description: changes.description ?? master.description,
          endUtc: master.isAllDay ? master.endUtc : startUtc + duration,
          geo: changes.geo === undefined ? master.geo : (changes.geo ?? undefined),
          location: changes.location ?? master.location,
          recurrence,
          reminders: defined.reminders ?? master.reminders,
          startUtc: master.isAllDay ? master.startUtc : startUtc,
          syncStatus: 'pending',
          title: changes.title ?? master.title,
          updatedAt: now,
        }),
      );
      const dropped = yield* dropUndrawnExceptions(params, merged, settled);
      yield* eventRepo.upsertMany([merged]);
      if (unsentCreate) {
        yield* pendingOpRepo.removeForEvent(accountId, calendarId, masterId);
        yield* enqueue(foldIntoCreate(unsentCreate, merged));
        // Google has no exceptions to carry text onto yet, but the
        // series' text still wins over an occurrence's own where this
        // edit sets it, as it does once the series is there: the queued
        // changes of its occurrences take it, and their rows show it.
        const waiting = (yield* pendingOpRepo.listAll()).filter(
          (op) =>
            op.accountId === accountId &&
            op.calendarId === calendarId &&
            op.kind === 'update' &&
            op.eventId.startsWith(`${masterId}_`),
        );
        yield* carryOntoQueued(
          waiting,
          merged,
          TEXT_FIELDS.filter((field) => merged[field] !== master[field]),
        );
        for (const op of waiting) {
          yield* heldEvents.show(op);
        }
        return;
      }
      // Google carries changed text onto the exceptions; so does the
      // local copy, undoably (carriedText.ts).
      const queued = yield* opsForEvent(accountId, calendarId, masterId);
      const { behind, replaced } = yield* queuedUpdate(
        { accountId, calendarId, eventId: masterId },
        queued,
      );
      // What this edit sets and Google will copy onto the exceptions.
      const carried = carriedFields(master, merged, replaced);
      const sets = TEXT_FIELDS.filter(
        (field) => merged[field] !== master[field] && carried.includes(field),
      );
      const { carriedText, rows } = planCarry({
        master,
        merged,
        overrides: yield* eventRepo.listOverrides(accountId, calendarId, masterId),
        owned: ownedText(behind, sets),
        queued: replaced,
      });
      yield* eventRepo.upsertMany(rows);
      yield* pendingOpRepo.enqueue(
        new PendingOp({
          accountId,
          attempts: 0,
          attendeesChanged: attendeesFlag(changes, queued),
          ...inheritedPark(queued),
          baseEtag: master.etag ?? undefined,
          beforeOverrides: dropped.taken?.length ? dropped.taken : undefined,
          beforePayload: inheritedBefore(queued, master),
          calendarId,
          carriedText,
          changed: inheritedChanged(queued),
          createdAt: notBefore(queued, now),
          // A new rule or new times drop the exceptions the series no
          // longer draws; a change queued before it dropped some already.
          dropsFrom: redraws(changes, master, merged) ? 0 : replaced?.dropsFrom,
          eventId: masterId,
          geoCleared: geoClearedFlag(master, merged, queued),
          id: generateEventId(),
          kind: 'update',
          nextAttemptAt: 0,
          payload: merged,
          recurrenceCleared: recurrenceClearedFlag(changes, queued),
          remindersChanged: remindersFlag(changes, queued),
        }),
        // A sent create stays ahead: this patch follows whatever it did.
        replaced?.id,
      );
      // A field the series no longer changes on Google (set back to what
      // Google has) is copied onto nothing: an occurrence's queued change
      // that had taken the series' text there sends its own again.
      if (replaced) {
        yield* restoreCarriedChanges(
          pendingOpRepo,
          replaced,
          TEXT_FIELDS.filter((field) => !carried.includes(field)),
        );
      }
      yield* carryOntoQueued(behind, merged, sets);
      yield* Effect.forEach(dropped.deletes, enqueue);
    });

  /** A "following" edit: the series splits at the occurrence into two. */
  const splitSeriesAt = (
    { accountId, calendarId, changes, masterId, originalStartUtc }: UpdateRecurringParams,
    recurrence: NonNullable<EventRecord['recurrence']>,
    { defined, duration, master, now, unsentCreate }: SettledSeriesEdit,
  ) =>
    Effect.gen(function* () {
      // this-and-following: truncate the old series before the occurrence
      // and start a new master at the (possibly re-timed) occurrence.
      const source = {
        endDate: master.endDate,
        endUtc: master.endUtc,
        id: master.id,
        isAllDay: master.isAllDay,
        recurrence,
        startDate: master.startDate,
        startTimeZone: master.startTimeZone ?? 'UTC',
        startUtc: master.startUtc,
      };
      const canSplit = yield* Effect.try({
        catch: () => new RecurringSplitUnsupportedError({ eventId: masterId }),
        try: () => canSplitRecurrence(source, originalStartUtc),
      });
      if (!canSplit) {
        return yield* Effect.fail(new RecurringSplitUnsupportedError({ eventId: masterId }));
      }
      const newRecurrence = remainingRecurrence(source, originalStartUtc);
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
      const dropped = yield* dropOverridesFrom(
        accountId,
        calendarId,
        masterId,
        originalStartUtc,
        now,
        { remote: !unsentCreate },
      );
      yield* truncateQueued(
        accountId,
        calendarId,
        master,
        truncated,
        unsentCreate,
        now,
        originalStartUtc,
        dropped.taken,
      );
      yield* Effect.forEach(dropped.deletes, enqueue);

      const projected = projectInstance(master, originalStartUtc, now);
      const startUtc =
        !master.isAllDay && changes.startUtc !== undefined ? changes.startUtc : projected.startUtc;
      // The new series starts at the occurrence's new time, and so does
      // every later one: a bound an earlier split left moves as for a
      // series edit (`retimedRecurrence`), or it draws that split's day too.
      const remainder = isRecurringSet(newRecurrence)
        ? master.isAllDay || startUtc === originalStartUtc
          ? newRecurrence
          : retimedRecurrence(
              // The remainder as drawn from the split occurrence's own slot.
              {
                ...source,
                endUtc: originalStartUtc + duration,
                recurrence: newRecurrence,
                startUtc: originalStartUtc,
              },
              startUtc,
              (utc) => applyWallClockDelta(utc, source.startTimeZone, originalStartUtc, startUtc),
            )
        : undefined;
      // An all-day split starts on the occurrence's slot (updateRecurring
      // refused a date change): the edit's dates would contradict startUtc.
      const {
        endDate: _endDate,
        endUtc: _endUtc,
        startDate: _startDate,
        startUtc: _startUtc,
        ...untimed
      } = defined;
      const newMaster = withConsistentGeo(
        new EventRecord({
          ...projected,
          ...(master.isAllDay ? untimed : defined),
          endUtc: master.isAllDay ? projected.endUtc : startUtc + duration,
          etag: null,
          id: generateEventId(),
          originalStartUtc: undefined,
          // The edit's own rule wins (null: the occurrence becomes a single
          // event). Otherwise the remainder of the old one — and splitting
          // a set of only RDATE lines on its last value leaves nothing to
          // repeat: the new half is a single event.
          recurrence:
            changes.recurrence === undefined ? remainder : (changes.recurrence ?? undefined),
          recurringEventId: undefined,
          startUtc,
          syncedAt: 0,
        }),
      );
      yield* eventRepo.upsertMany([newMaster]);
      // Split off a series whose create is unsent (it took the cut in), it
      // is that one's: split off the same series at the same occurrence.
      const splitOf = unsentCreate ? unsentCreate.splitOf : masterId;
      const splitIn = unsentCreate ? unsentCreate.splitIn : calendarId;
      const splitAt = unsentCreate ? unsentCreate.splitAt : originalStartUtc;
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
          ...(splitOf === undefined ? {} : { splitAt, splitIn, splitOf }),
        }),
      );
    });

  const shape: Omit<
    EventMutationsShape,
    | 'convertEventToTask'
    | 'convertTaskToEvent'
    | 'moveEvent'
    | 'moveTask'
    | 'previewDeleteTask'
    | 'previewEventToTask'
    | 'previewMove'
    | 'previewMoveTask'
    | 'previewTaskToEvent'
  > = {
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
        const queued = yield* opsForEvent(accountId, calendarId, eventId);
        const unsentCreate = queued.find(
          (op) => op.kind === 'create' && op.dispatchedAt === undefined,
        );
        yield* eventRepo.deleteEvent(accountId, calendarId, eventId);
        if (unsentCreate) {
          // Never sent: dropping its create is the whole delete.
          yield* pendingOpRepo.removeForEvent(accountId, calendarId, eventId);
        } else {
          // A sent create stays ahead: the delete follows whatever it did.
          yield* supersedeQueued(accountId, calendarId, eventId);
          const now = yield* Clock.currentTimeMillis;
          yield* enqueue(
            new PendingOp({
              accountId,
              attempts: 0,
              ...inheritedPark(queued),
              baseEtag: existing.etag ?? undefined,
              // A series cleared while offline holds the exceptions that
              // change dropped: Google cancels them with the event, and
              // they are this delete's now, to put back if it is given up.
              beforeOverrides: heldWith(
                queued.findLast((op) => op.kind === 'update'),
                [],
              ),
              beforePayload: inheritedBefore(queued, existing),
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
          const existing = yield* occurrenceRow(accountId, calendarId, masterId, instanceId);
          const tombstone = new EventRecord({
            ...(existing ?? projectInstance(master, originalStartUtc, now)),
            status: 'cancelled',
            syncStatus: 'pending',
            updatedAt: now,
          });
          yield* eventRepo.upsertMany([tombstone]);
          const queued = yield* opsForEvent(accountId, calendarId, instanceId);
          const seriesEdits = seriesEditsOf(yield* opsForEvent(accountId, calendarId, masterId));
          yield* pendingOpRepo.removeForEvent(accountId, calendarId, instanceId);
          yield* enqueue(
            new PendingOp({
              accountId,
              attempts: 0,
              ...inheritedPark(queued),
              baseEtag: existing?.etag ?? undefined,
              beforePayload: ownTextOf(inheritedBefore(queued, existing), seriesEdits),
              calendarId,
              createdAt: notBefore(yield* opsForEvent(accountId, calendarId, masterId), now),
              eventId: instanceId,
              id: generateEventId(),
              kind: 'delete',
              nextAttemptAt: 0,
              payload: tombstone,
            }),
          );
          return;
        }

        // A series delete or cut below replaces one still queued: what that
        // one took is Google's, for this one to take or to cut.
        yield* restoreTakenExceptions(accountId, calendarId, masterId);
        const unsentCreate = yield* unsentCreateOf(accountId, calendarId, masterId);
        if (scope === 'series' || originalStartUtc <= master.startUtc) {
          // Deleting the master cascades to its exceptions server-side.
          // They go with the master locally and come back with it on a
          // discard — as Google has them: an exception edited offline goes
          // back to its acknowledged state (its op goes with it here), one
          // this device only materialized does not come back at all.
          const overrides = yield* eventRepo.listOverrides(accountId, calendarId, masterId);
          const queued = yield* opsForEvent(accountId, calendarId, masterId);
          // A queued series edit carried its text onto them locally; that
          // op goes with the master too, so their own text is taken now.
          const seriesEdits = seriesEditsOf(queued);
          // What a cut, a new rule or new times still queued had dropped
          // is Google's too, and this delete's now.
          const beforeOverrides: Array<EventRecord> = [
            ...(heldWith(
              queued.findLast((op) => op.kind === 'update'),
              [],
            ) ?? []),
          ];
          for (const override of overrides) {
            // Google's copy of each: the one its own queued ops hold, else
            // the row itself, which nothing changed here.
            const own = yield* opsForEvent(accountId, calendarId, override.id);
            const holder = own.find(
              (op) => op.kind === 'delete' || op.kind === 'rsvp' || op.kind === 'update',
            );
            const acked =
              holder === undefined || isPulledCopy(own, override) ? override : holder.beforePayload;
            if (acked) {
              beforeOverrides.push(ownTextOf(acked, seriesEdits));
            }
            yield* pendingOpRepo.removeForEvent(accountId, calendarId, override.id);
            yield* eventRepo.deleteEvent(accountId, calendarId, override.id);
          }
          yield* eventRepo.deleteEvent(accountId, calendarId, masterId);
          if (unsentCreate) {
            // Never sent: dropping its create is the whole delete.
            return yield* pendingOpRepo.removeForEvent(accountId, calendarId, masterId);
          }
          // A sent create stays ahead: the delete follows whatever it did.
          yield* supersedeQueued(accountId, calendarId, masterId);
          yield* enqueue(
            new PendingOp({
              accountId,
              attempts: 0,
              ...inheritedPark(queued),
              baseEtag: master.etag ?? undefined,
              beforeOverrides,
              beforePayload: inheritedBefore(queued, master),
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
        const dropped = yield* dropOverridesFrom(
          accountId,
          calendarId,
          masterId,
          originalStartUtc,
          now,
          { remote: !unsentCreate },
        );
        yield* truncateQueued(
          accountId,
          calendarId,
          master,
          truncated,
          unsentCreate,
          now,
          originalStartUtc,
          dropped.taken,
        );
        yield* Effect.forEach(dropped.deletes, enqueue);
      }),

    discardPendingOp,

    landedInPull,

    processPendingOps,

    // Under the drain's gate: a copy whose request is out settles first.
    releaseAccountCopies: (accountId) =>
      gate.withPermits(1)(sql.withTransaction(releaseAccountCopies(accountId))),

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
        // Only the latest response needs to reach Google. A delete still
        // queued goes too: the user answered Google's copy put back at its
        // id while it waited, and the answer keeps the event, as an edit
        // does.
        yield* restoreTakenExceptions(accountId, calendarId, eventId);
        const queued = yield* opsForEvent(accountId, calendarId, eventId);
        // What already holds the event knows what Google has of it: none
        // for an occurrence an edit here materialized. Named as Google's
        // copy, that edit's row made the edit differ from it in nothing.
        const holder = queued.find((op) => op.kind === 'rsvp' || op.kind === 'update');
        for (const op of queued) {
          if (op.kind === 'rsvp' || op.kind === 'delete') {
            yield* pendingOpRepo.remove(op.id);
          }
        }
        yield* enqueue(
          new PendingOp({
            accountId,
            attempts: 0,
            // Sent as If-Match, retried without on a 412 (applyOp): when it
            // holds, the edits queued on this etag can follow the RSVP.
            baseEtag: existing.etag ?? undefined,
            // Google's copy at a waiting delete's id (isPulledCopy), else the
            // one the answer it replaces read.
            beforePayload:
              holder && !isPulledCopy(queued, existing) ? holder.beforePayload : existing,
            calendarId,
            // The user's own answer is this op's, also where it is the one
            // Google has: an answer of theirs may be out.
            changed: existing.attendees.filter(isOwn).map((attendee) => attendee.email),
            createdAt: now,
            eventId,
            id: generateEventId(),
            kind: 'rsvp',
            nextAttemptAt: 0,
            payload: merged,
          }),
        );
      }),

    retryPendingOps: () =>
      pendingOpRepo
        .retryNow()
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning('could not make queued changes due', { cause: String(cause) }),
          ),
        ),

    setCalendarColor: ({ accountId, calendarId, colorHex }) =>
      Effect.gen(function* () {
        const normalized = normalizeHexColor(colorHex);
        if (!normalized) {
          return yield* Effect.fail(new InvalidColorError({ colorHex }));
        }
        const current = (yield* calendarRepo.list(accountId)).find(
          (calendar) => calendar.id === calendarId,
        )?.colorHex;
        yield* calendarRepo.setColor(accountId, calendarId, normalized);
        // Only the latest color needs to reach Google — scoped by account:
        // the same shared calendar id can exist under several accounts.
        const queued = yield* opsForEvent(accountId, calendarId, CALENDAR_COLOR_EVENT_ID);
        const prior = queued.find((op) => op.accountId === accountId);
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
            // The replaced change's baseline carries over while the calendar
            // still shows that change; a color a pull installed meanwhile is
            // Google's and becomes the baseline.
            beforeColorHex: prior && current === prior.colorHex ? prior.beforeColorHex : current,
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
        if (changes.recurrence !== undefined) {
          // A single event does not become a series through an update.
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

        // Coalesce: an unsent create absorbs the change; otherwise a fresh
        // update op replaces any queued update — and inherits its guest-list
        // flag, since the merged record still carries that edit — and
        // queues behind a sent create.
        const queued = yield* opsForEvent(accountId, calendarId, eventId);
        const unsentCreate = queued.find(
          (op) => op.kind === 'create' && op.dispatchedAt === undefined,
        );
        if (unsentCreate) {
          yield* pendingOpRepo.removeForEvent(accountId, calendarId, eventId);
          return yield* enqueue(foldIntoCreate(unsentCreate, merged));
        }
        // A series cleared while offline keeps that change where it is,
        // ahead of the user's own deletes of its occurrences behind it.
        const { replaced } = yield* queuedUpdate({ accountId, calendarId, eventId }, queued);
        yield* pendingOpRepo.enqueue(
          new PendingOp({
            accountId,
            attempts: 0,
            attendeesChanged: attendeesFlag(changes, queued),
            ...inheritedPark(queued),
            baseEtag: existing.etag ?? undefined,
            beforePayload: inheritedBefore(queued, existing),
            calendarId,
            changed: inheritedChanged(queued),
            createdAt: notBefore(queued, now),
            // A series cleared while offline drops its exceptions on Google;
            // an edit that replaces that queued op drops them in its place.
            dropsFrom: replaced?.dropsFrom,
            eventId,
            geoCleared: geoClearedFlag(existing, merged, queued),
            id: generateEventId(),
            kind: 'update',
            nextAttemptAt: 0,
            payload: merged,
            // A series cleared while offline is a single event here already;
            // an edit that replaces that queued op must still clear it there.
            recurrenceCleared: recurrenceClearedFlag(changes, queued),
            remindersChanged: remindersFlag(changes, queued),
          }),
          replaced?.id,
        );
      }),

    updateRecurring: (params) =>
      Effect.gen(function* () {
        const { accountId, calendarId, changes, masterId, originalStartUtc, scope } = params;
        const { master, recurrence } = yield* loadMaster(accountId, calendarId, masterId);
        const now = yield* Clock.currentTimeMillis;
        // Series/following edits merge guests against the master; an
        // instance edit merges against the occurrence's own list
        // (updateOccurrence) — an override can carry responses the master
        // does not.
        const defined = definedChanges(changes, master.attendees);
        if (scope === 'instance' && changes.recurrence !== undefined) {
          // One occurrence cannot carry its own rule.
          return yield* Effect.fail(new RecurringEditUnsupportedError({ eventId: masterId }));
        }

        if (scope === 'instance') {
          return yield* updateOccurrence(params, master, now);
        }

        if (changes.isAllDay !== undefined && changes.isAllDay !== master.isAllDay) {
          return yield* Effect.fail(new RecurringAllDaySwitchError({ eventId: masterId }));
        }
        // The series and following edits below replace a queued delete.
        yield* restoreTakenExceptions(accountId, calendarId, masterId);
        if (master.isAllDay && changes.startDate !== undefined) {
          // The date the occurrence shows now: its exception's, else its slot's.
          const exception = yield* eventRepo.getById(
            accountId,
            calendarId,
            googleInstanceId(masterId, originalStartUtc, true),
          );
          if (changes.startDate !== (exception?.startDate ?? isoDate(originalStartUtc))) {
            return yield* Effect.fail(new RecurringAllDayMoveError({ eventId: masterId }));
          }
        }
        const unsentCreate = yield* unsentCreateOf(accountId, calendarId, masterId);

        const duration =
          changes.startUtc !== undefined && changes.endUtc !== undefined
            ? changes.endUtc - changes.startUtc
            : master.endUtc - master.startUtc;

        const settled = { defined, duration, master, now, unsentCreate };
        if (scope === 'series' || originalStartUtc <= master.startUtc) {
          return yield* updateSeries(params, settled);
        }
        yield* splitSeriesAt(params, recurrence, settled);
      }),

    whileQueueHeld: (effect) => gate.withPermits(1)(effect),
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

  /**
   * An existing event changes only in a calendar we can write. Google
   * answers 403 for the rest, and the dropped op used to mark the edited
   * row synced: a dragged event showed the wrong time until the server
   * copy changed. A calendar we have no row for passes; the provider judges.
   */
  const requireWritable = (accountId: string, calendarId: string) =>
    Effect.flatMap(findCalendar(accountId, calendarId), (calendar) =>
      calendar && !isCalendarWritable(calendar)
        ? Effect.fail(new CalendarNotWritableError({ calendarId }))
        : Effect.void,
    );

  /**
   * The source event as a whole (the series for a recurring one).
   * `forPreview`: also count an Apple series' changed occurrences — only
   * a preview shows that number, and counting reads four years of
   * EventKit across every calendar.
   */
  const loadSource = (params: EventRef, provider: 'apple' | 'google', forPreview = false) =>
    Effect.gen(function* () {
      const { accountId, calendarId, eventId } = params;
      if (provider === 'apple') {
        const series = yield* appleClient.series({ id: eventId });
        const now = yield* Clock.currentTimeMillis;
        const mapped = mapAppleEvent(series.first, { deviceTimeZone: deviceTimeZone(), now });
        const recurrence = toRRuleLines(series.rules, series.first.isAllDay);
        const modifiedOccurrences =
          forPreview && series.rules.length > 0
            ? yield* countAppleChangedOccurrences(appleClient, series.first)
            : 0;
        return {
          defaultReminders: undefined,
          master: new EventRecord({
            ...mapped,
            id: eventId,
            originalStartUtc: undefined,
            recurrence: recurrence.length > 0 ? recurrence : undefined,
            recurringEventId: undefined,
          }),
          modifiedOccurrences,
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
   * One occurrence of a series as a conversion's source. Google: its own
   * row where it was edited on its own, else the master's fields at its
   * slot. Apple: the occurrence as EventKit has it, edited or not, where
   * a delete by its slot reaches it. The rule and the other occurrences
   * stay with the series, so the source has neither to carry or to lose.
   * A slot the series does not draw (any more) is no event.
   */
  const loadOccurrence = (
    params: EventRef,
    originalStartUtc: number,
    provider: 'apple' | 'google',
  ) =>
    Effect.gen(function* () {
      const { accountId, calendarId, eventId } = params;
      const now = yield* Clock.currentTimeMillis;
      if (provider === 'apple') {
        const found = yield* findAppleOccurrence(appleClient, { id: eventId, originalStartUtc });
        if (!found) {
          return yield* Effect.fail(new EventNotFoundError({ eventId }));
        }
        return {
          defaultReminders: undefined,
          master: mapAppleEvent(found, { deviceTimeZone: deviceTimeZone(), now }),
          modifiedOccurrences: 0,
          url: found.url,
        } satisfies MoveSource;
      }
      const { master } = yield* loadMaster(accountId, calendarId, eventId);
      const instanceId = googleInstanceId(eventId, originalStartUtc, master.isAllDay);
      const own = yield* occurrenceRow(accountId, calendarId, eventId, instanceId);
      const projected = projectInstance(master, originalStartUtc, now);
      if (own ? own.status === 'cancelled' : !drawsSlot(master, projected)) {
        return yield* Effect.fail(new EventNotFoundError({ eventId: instanceId }));
      }
      const calendar = yield* findCalendar(accountId, calendarId);
      return {
        defaultReminders: calendar?.defaultReminders,
        master: new EventRecord({ ...(own ?? projected), recurrence: undefined }),
        modifiedOccurrences: 0,
        url: undefined,
      } satisfies MoveSource;
    });

  /** What a conversion reads: the whole event, or the one occurrence it names. */
  const loadConvertSource = (
    params: EventRef & Pick<PreviewEventToTaskParams, 'occurrence'>,
    provider: 'apple' | 'google',
    forPreview = false,
  ) =>
    params.occurrence === undefined
      ? loadSource(params, provider, forPreview)
      : loadOccurrence(params, params.occurrence.originalStartUtc, provider);

  /**
   * Google → Google inside one account: events.move keeps the id, guests,
   * conference and exceptions. Rows are re-keyed to the target now; any
   * queued edit of the series is re-queued *behind* the move against the
   * target calendar (the drain holds either side back until the other
   * lands — see applyOp; a move Google never makes takes them back to the
   * source, applyOp releaseMove), and a create that never reached Google simply
   * becomes a create in the target. A create already sent may have landed
   * in the source (its response lost): it stays queued there with the move
   * behind it, since re-keyed it would insert a second copy in the target.
   *
   * A delete of the event still queued means the user moved Google's copy
   * put back at its id while it waited (isPulledCopy): the move replaces
   * it, as an edit does (supersedeQueued). An exception's delete (a
   * this-and-following cut) goes behind the move, and a row of it put
   * back as Google's moves with it, still synced, for that delete to take
   * once it lands (applyOp dropPulledCopy leaves pending rows alone).
   */
  const googleServerMove = (params: MoveEventParams) =>
    Effect.gen(function* () {
      const { accountId, calendarId, eventId, target } = params;
      const { master } = yield* loadSource(params, 'google');
      const account = yield* accountRepo.get(accountId);
      yield* ensureOrganizer(master, account?.email, calendarId);
      // The destination's own event of that id: this one's row would
      // replace it, and a page that names it there would read as the move
      // landed (`landedInPull`).
      // Deleted here, it is still there for Google while that delete waits.
      // And another event of the id that is moving between other calendars:
      // what a page brings for a moving event finds its rows by its id.
      const there = { accountId, calendarId: target.calendarId, eventId };
      const moves = (yield* pendingOpRepo.listAll()).filter(
        (op) => op.kind === 'move' && op.accountId === accountId && op.eventId === eventId,
      );
      // This event's own way here: the calendars its queued moves took it
      // through, followed back from where it is.
      const own = new Set([calendarId]);
      for (const op of moves.toReversed()) {
        if (own.has(op.targetCalendarId ?? '')) {
          own.add(op.calendarId);
        }
      }
      const elsewhere = moves.some((op) => !own.has(op.targetCalendarId ?? ''));
      if (
        elsewhere ||
        (yield* eventRepo.getById(accountId, target.calendarId, eventId)) ||
        // (A move queued there is this event's own way out of it or back,
        // and a create its own beginning there.)
        (yield* pendingOpRepo.listForEvent(there)).some(
          (op) => op.kind !== 'move' && op.kind !== 'create',
        )
      ) {
        return yield* Effect.fail(
          new EventAlreadyThereError({
            calendarId: target.calendarId,
            eventId,
            message: elsewhere
              ? 'Another event with this id is still moving. Try again once it synced.'
              : 'That calendar already has this event.',
          }),
        );
      }
      const now = yield* Clock.currentTimeMillis;
      yield* restoreTakenExceptions(accountId, calendarId, master.id);
      // Also of an event whose rule was cleared while offline: the
      // tombstone of an occurrence the user deleted before that waits with
      // its delete, and left in the source it stayed pending for good.
      const overrides = yield* eventRepo.listOverrides(accountId, calendarId, eventId);
      const seriesIds = new Set([master.id, ...overrides.map((row) => row.id)]);
      const inSeries = (yield* pendingOpRepo.listAll()).filter(
        (op) =>
          op.accountId === accountId &&
          op.calendarId === calendarId &&
          (seriesIds.has(op.eventId) ||
            (op.kind === 'delete' && op.payload?.recurringEventId === master.id)),
      );
      const deleting = new Set(
        inSeries.filter((op) => op.kind === 'delete').map((op) => op.eventId),
      );
      for (const row of [master, ...overrides]) {
        const pulledCopy =
          row.id !== master.id && row.status !== 'cancelled' && deleting.has(row.id);
        yield* eventRepo.deleteEvent(accountId, calendarId, row.id);
        yield* eventRepo.upsertMany([
          new EventRecord({
            ...row,
            calendarId: target.calendarId,
            syncStatus: pulledCopy ? row.syncStatus : 'pending',
          }),
        ]);
      }
      const pendingCreate = inSeries.find((op) => op.kind === 'create' && op.eventId === master.id);
      const sentCreate = pendingCreate?.dispatchedAt === undefined ? undefined : pendingCreate;
      // An earlier move out of this calendar (the event was here before,
      // left, and came back with a move still queued) stays as it is: it
      // runs before this one. Re-keyed as a follower it became a move to
      // its own destination, queued behind this one, and the move back
      // between them went first, met a 404 and counted as landed.
      const queued = inSeries.filter((op) => op !== sentCreate && op.kind !== 'move');
      for (const op of queued) {
        yield* pendingOpRepo.remove(op.id);
      }
      // The move itself bumps the event's etag, so a re-queued edit must
      // not send its pre-move If-Match: it would 412 and park. A parked op
      // stays parked (conflictAt rides along): dropping the park with the
      // etag would silently decide the conflict for the user.
      const rekey = (op: PendingOp, createdAt: number) =>
        new PendingOp({
          ...retargetOp(op, target.calendarId),
          baseEtag: undefined,
          createdAt,
          id: generateEventId(),
        });
      if (!pendingCreate || sentCreate) {
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
        if (op.kind !== 'delete' || op.eventId !== master.id) {
          yield* enqueue(rekey(op, now + 1));
        }
      }
      // The series split off it follow it there (splitSeries.ts).
      yield* pendingOpRepo.moveSplits(accountId, master.id, calendarId, target.calendarId);
    });

  const createIn = (provider: 'apple' | 'google', draft: EventDraft) =>
    provider === 'apple' ? apple.createEvent(draft) : shape.createEvent(draft);

  const deleteFrom = (provider: 'apple' | 'google', params: EventRef, master: EventRecord) =>
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

  /**
   * One occurrence leaves its series: the same delete "This event" runs.
   * Apple: `loadOccurrence` found it where that delete reaches, before the
   * copy was made, so the delete does not look again — an occurrence
   * removed elsewhere meanwhile is a finished conversion, not a failure
   * to report beside the copy.
   */
  const deleteOccurrenceFrom = (
    provider: 'apple' | 'google',
    params: EventRef,
    originalStartUtc: number,
  ) =>
    provider === 'apple'
      ? apple.deleteFoundOccurrence({
          accountId: params.accountId,
          masterId: params.eventId,
          originalStartUtc,
        })
      : shape.deleteRecurring({
          accountId: params.accountId,
          calendarId: params.calendarId,
          masterId: params.eventId,
          originalStartUtc,
          scope: 'instance',
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
      // Moving out deletes from the source, which a read-only calendar refuses.
      yield* requireWritable(accountId, calendarId);
      const targetCalendar = yield* findCalendar(target.accountId, target.calendarId);
      if (!isCalendarWritable(targetCalendar)) {
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
      yield* crossStore(
        route,
        eventFrom(params, route.source, source),
        createIn(route.target, draft),
        deleteFrom(route.source, params, source.master),
      );
    });

  const previewMove = (params: MoveEventParams) =>
    Effect.gen(function* () {
      const route = yield* routeOf(params);
      if (isServerMove(route) || (route.source === 'apple' && route.target === 'apple')) {
        return moveLoss({ isAllDay: false }, route, 0);
      }
      const source = yield* loadSource(params, route.source, true);
      return moveLoss(source.master, route, source.modifiedOccurrences);
    });

  /**
   * An Apple source made again, as it was when it was copied toward
   * Google (applyOp releaseCopySource): the copy will not land. A new
   * item — EventKit gives it a new identifier — in the calendar or list it
   * came from; a series without the occurrences changed on their own,
   * which the copy did not carry either.
   */
  const restoreSource = (source: AppleCopySource): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (source.kind === 'appleEvent') {
        const { event, url } = source;
        yield* apple.createEvent(
          copyDraft(
            { defaultReminders: undefined, master: event, modifiedOccurrences: 0, url },
            { accountId: event.accountId, calendarId: event.calendarId },
            'apple',
          ),
        );
        return;
      }
      const { task } = source;
      const created = yield* reminders.createTask({
        accountId: task.accountId,
        alarms: task.alarms,
        dueDate: task.dueDate,
        dueTime: task.dueTime,
        notes: task.notes,
        priority: task.priority,
        recurrence: task.recurrenceUnsupported ? undefined : task.recurrence,
        taskListId: task.listId,
        title: task.title,
        url: task.url,
      });
      yield* completedLike('apple', created, task);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning('a copy did not land and its source was not made again', {
          cause: String(Cause.squash(cause)),
          kind: source.kind,
        }),
      ),
    );

  /** A created task completed like its source, if that was done. */
  const completedLike = (provider: 'apple' | 'google', created: TaskRecord, like: TaskRecord) =>
    Effect.gen(function* () {
      if (like.status !== 'completed') {
        return created;
      }
      const complete = {
        accountId: created.accountId,
        status: 'completed' as const,
        taskId: created.id,
        taskListId: created.listId,
      };
      yield* provider === 'apple'
        ? reminders.completeTask(complete)
        : googleTasks.completeTask(complete);
      return new TaskRecord({ ...created, status: 'completed' });
    });

  /**
   * Moving a task: between two Reminders lists EventKit changes the list
   * in place and the identifier survives, and inside one Google account
   * `tasks.move` does the same — the subtasks come along, nested as they
   * were, and the task leaves a parent it had. Every other route creates
   * the task in the target from the draft and then deletes the source, so
   * a failure between the two leaves a duplicate, never a lost task. The
   * draft, not the source row, is what gets written: the editor showed
   * the target provider's form, and its fields are the user's intent.
   * A Google task's subtasks are created too — nested under the copy on
   * Google, as reminders of their own in Reminders — and deleted with it
   * (Google deletes a parent's subtasks with it). Completion follows.
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
      if (
        sourceProvider === 'google' &&
        targetProvider === 'google' &&
        accountId === target.accountId
      ) {
        return yield* transactional(
          Effect.gen(function* () {
            // The form's edits land first, in the source list; the move
            // takes them along (the drain keeps the order).
            yield* rejectReminderFields(draft);
            const changes = {
              ...(draft.dueDate === source.dueDate ? {} : { dueDate: draft.dueDate }),
              ...((draft.notes ?? '') === (source.notes ?? '') ? {} : { notes: draft.notes ?? '' }),
              ...(draft.title === source.title ? {} : { title: draft.title }),
            };
            if (Object.keys(changes).length > 0) {
              yield* googleTasks.updateTask({ accountId, changes, taskId, taskListId });
            }
            return yield* googleTasks.moveWithinAccount({
              accountId,
              targetTaskListId: target.taskListId,
              taskId,
              taskListId,
            });
          }),
        );
      }
      const subtasks =
        sourceProvider === 'google'
          ? yield* taskRepo.listSubtasks(accountId, taskListId, taskId)
          : [];
      const createParams = { ...draft, accountId: target.accountId, taskListId: target.taskListId };
      const createIn = (provider: 'apple' | 'google') =>
        Effect.gen(function* () {
          const created = yield* completedLike(
            provider,
            yield* createTaskIn(provider, createParams),
            source,
          );
          // Its subtasks follow. Google inserts a subtask first among its
          // siblings, so they go in last to first and keep their order.
          const ordered = provider === 'google' ? [...subtasks].reverse() : subtasks;
          for (const subtask of ordered) {
            const fields = {
              accountId: target.accountId,
              ...(subtask.dueDate === undefined ? {} : { dueDate: subtask.dueDate }),
              ...(subtask.notes === undefined ? {} : { notes: subtask.notes }),
              taskListId: target.taskListId,
              title: subtask.title,
            };
            yield* completedLike(
              provider,
              provider === 'google'
                ? yield* googleTasks.createSubtask({ ...fields, parentId: created.id })
                : yield* reminders.createTask(fields),
              subtask,
            );
          }
          return created;
        });
      // The delete takes the subtasks first, as Google would with their parent.
      return yield* crossStore(
        { source: sourceProvider, target: targetProvider },
        taskFrom(source, sourceProvider),
        createIn(targetProvider),
        deleteTaskFrom(sourceProvider, { accountId, taskId, taskListId }),
      );
    });

  const previewMoveTask = (params: PreviewMoveTaskParams) =>
    Effect.gen(function* () {
      const { accountId, target, taskId, taskListId } = params;
      const source = yield* taskRepo.get(accountId, taskListId, taskId);
      if (!source) {
        return yield* Effect.fail(new TaskNotFoundError({ taskId }));
      }
      const sourceProvider = yield* providerOf(accountId);
      const subtasks =
        sourceProvider === 'google'
          ? yield* taskRepo.listSubtasks(accountId, taskListId, taskId)
          : [];
      return taskMoveLoss(
        source,
        {
          sameAccount: accountId === target.accountId,
          source: sourceProvider,
          target: yield* providerOf(target.accountId),
        },
        subtasks.length,
      );
    });

  /** Reminders rows never have a parent, so only a Google task counts any. */
  const previewDeleteTask = ({ accountId, taskId, taskListId }: TaskAddressParams) =>
    Effect.map(taskRepo.listSubtasks(accountId, taskListId, taskId), (subtasks) => ({
      subtasks: subtasks.length,
    }));

  // ---- conversions ----

  /**
   * An event becomes a task: the task is created in the target list from
   * the draft (the task form's fields), then the event is deleted — the
   * whole series for a recurring one, or with `occurrence` that one
   * occurrence, which the series then skips like one deleted on its own.
   * Like a move, an invitation cannot be converted by a guest.
   */
  const convertEventToTask = (params: ConvertEventToTaskParams) =>
    Effect.gen(function* () {
      const { accountId, calendarId, draft, occurrence, target } = params;
      yield* requireWritable(accountId, calendarId);
      const sourceProvider = yield* providerOf(accountId);
      const targetProvider = yield* providerOf(target.accountId);
      const source = yield* loadConvertSource(params, sourceProvider);
      const account = yield* accountRepo.get(accountId);
      yield* ensureOrganizer(source.master, account?.email, calendarId);
      return yield* crossStore(
        { source: sourceProvider, target: targetProvider },
        eventFrom(params, sourceProvider, source),
        createTaskIn(targetProvider, {
          ...draft,
          accountId: target.accountId,
          taskListId: target.taskListId,
        }),
        occurrence === undefined
          ? deleteFrom(sourceProvider, params, source.master)
          : deleteOccurrenceFrom(sourceProvider, params, occurrence.originalStartUtc),
      );
    });

  /** A task becomes an event: the event is created from the draft, then the task is deleted. */
  const convertTaskToEvent = (params: ConvertTaskToEventParams) =>
    Effect.gen(function* () {
      const { accountId, draft, taskId, taskListId } = params;
      const source = yield* taskRepo.get(accountId, taskListId, taskId);
      if (!source) {
        return yield* Effect.fail(new TaskNotFoundError({ taskId }));
      }
      const targetCalendar = yield* findCalendar(draft.accountId, draft.calendarId);
      if (!isCalendarWritable(targetCalendar)) {
        return yield* Effect.fail(new CalendarNotWritableError({ calendarId: draft.calendarId }));
      }
      const sourceProvider = yield* providerOf(accountId);
      const targetProvider = yield* providerOf(draft.accountId);
      return yield* crossStore(
        { source: sourceProvider, target: targetProvider },
        taskFrom(source, sourceProvider),
        createIn(targetProvider, draft),
        deleteTaskFrom(sourceProvider, { accountId, taskId, taskListId }),
      );
    });

  /** The stored task decides what is lost; its subtasks go with the delete. */
  const previewTaskToEvent = ({ accountId, taskId, taskListId }: TaskAddressParams) =>
    Effect.gen(function* () {
      const source = yield* taskRepo.get(accountId, taskListId, taskId);
      if (!source) {
        return yield* Effect.fail(new TaskNotFoundError({ taskId }));
      }
      const subtasks = yield* taskRepo.listSubtasks(accountId, taskListId, taskId);
      return taskToEventLoss(source, subtasks.length);
    });

  const previewEventToTask = (params: PreviewEventToTaskParams) =>
    Effect.gen(function* () {
      const sourceProvider = yield* providerOf(params.accountId);
      const targetProvider = yield* providerOf(params.target.accountId);
      // One occurrence comes without the series' rule: nothing to carry, nothing lost.
      const { master, modifiedOccurrences, url } = yield* loadConvertSource(
        params,
        sourceProvider,
        true,
      );
      const timeZone = master.startTimeZone ?? 'UTC';
      const carriedRecurrence = taskRecurrenceFromLines(master.recurrence, {
        isAllDay: master.isAllDay,
        startTime: master.isAllDay
          ? undefined
          : toZonedDateTime(master.startUtc, timeZone)
              .toPlainTime()
              .toString({ smallestUnit: 'minute' }),
        timeZone,
      });
      return {
        ...(carriedRecurrence === undefined ? {} : { carriedRecurrence }),
        // An Apple event's plain URL is not on the record (only a meeting URL is).
        ...(url === undefined ? {} : { carriedUrl: url }),
        loss: eventToTaskLoss(master, targetProvider, modifiedOccurrences),
      };
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

  /** Edits and deletes of an existing event: only where we can write (requireWritable). */
  const writable =
    <P extends { readonly accountId: string; readonly calendarId: string }, A, E>(
      write: (params: P) => Effect.Effect<A, E>,
    ) =>
    (params: P): Effect.Effect<A, E | CalendarNotWritableError | SqlError> =>
      Effect.andThen(requireWritable(params.accountId, params.calendarId), write(params));

  return {
    ...shape,
    convertEventToTask,
    convertTaskToEvent,
    createEvent: byProvider(apple.createEvent, google.createEvent),
    deleteEvent: writable(byProvider(apple.deleteEvent, google.deleteEvent)),
    deleteRecurring: writable(byProvider(apple.deleteRecurring, google.deleteRecurring)),
    moveEvent,
    moveTask,
    previewDeleteTask,
    previewEventToTask,
    previewMove,
    previewMoveTask,
    previewTaskToEvent,
    respondToEvent: byProvider(apple.respondToEvent, google.respondToEvent),
    setCalendarColor: byProvider(apple.setCalendarColor, google.setCalendarColor),
    updateEvent: writable(byProvider(apple.updateEvent, google.updateEvent)),
    updateRecurring: writable(byProvider(apple.updateRecurring, google.updateRecurring)),
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
