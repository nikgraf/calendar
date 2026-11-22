import {
  addDaysToPlainDate,
  daysBetweenPlainDates,
  expandRecurringEvent,
  googleInstanceId,
  plainDateToUtcMs,
  recurrenceMasterOf,
} from '@calendar/core';
import type {
  GcalCalendarListEntry,
  GcalEvent,
  GcalPerson,
  GcalTask,
  GcalTaskList,
} from '@calendar/google';
import { mapGcalEvent, TokenManager, type TokenManagerShape } from '@calendar/google';
import { Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse, UrlParams, type HttpClientRequest } from 'effect/http';

/**
 * An in-process Google (Calendar + Tasks) behind effect's HttpClient, so
 * the real clients, request core and sync engine run against something
 * that answers like the API: sync tokens that go stale (410), cancelled
 * tombstones, If-Match → 412, a re-posted event id → 409 (a deleted
 * event keeps its id reserved), events.update as a full replace that can
 * bring a deleted event back, server-assigned task ids, the updatedMin
 * watermark with deleted tombstones, sibling positions renumbered on every
 * insert, delete and move without an `updated` bump, and a list `updated`
 * that every one of those moves. Every semantic here mirrors
 * docs/google-sync-and-testing.md; before this, those were prose only.
 *
 * Repeating events as that document records them (Events & recurrence)
 * and as `live/recurring.live.ts` finds them on Google: a master holds the
 * rule lines; an occurrence changed on its own is an exception, an event
 * of its own under `<masterId>_<original start>` with `recurringEventId`
 * and `originalStartTime`. A PATCH of that id makes or changes the
 * exception and a DELETE cancels the occurrence, also where no exception
 * was stored; a DELETE of one already cancelled is a 410. Every PATCH of
 * the master gives each exception a new etag and `updated`; a title,
 * description or location it changed is copied onto them; a rule it sets
 * keeps the exceptions it still draws as they are and cancels the others
 * (a rule that skips the slot, an UNTIL before it, no rule at all). A
 * master's DELETE takes its exceptions, events.move takes them along, and
 * a list reports all of it. Which slots a rule draws is core's own
 * expansion, the one the app draws with. Where Google's answer is not
 * recorded the fake does not invent one: it answers as it did before it
 * knew series and says so in `unverified` — and in `goneWithExceptions`
 * for the one such answer a list gives (what it reports for the
 * exceptions of a series that left the calendar).
 */

interface StoredEvent {
  readonly event: GcalEvent;
  readonly version: number;
}

interface StoredTask {
  readonly task: GcalTask;
  /** epoch ms of the last write — the RFC 3339 `updated` field */
  readonly updatedAt: number;
}

type ExtendedProperties = GcalEvent['extendedProperties'];
type EventTime = GcalEvent['start'];

/** What a route answers: the status, and the body where it has one. */
interface Answer {
  readonly json?: unknown;
  readonly status: number;
}

/** One occurrence of a series, named by its id. */
interface OccurrenceRef {
  readonly allDay: boolean;
  readonly masterId: string;
  /** Its original start, epoch ms (an all-day one: its day at 00:00 UTC). */
  readonly slot: number;
}

/**
 * `<masterId>_<YYYYMMDDTHHMMSSZ>`, the original start in UTC, or
 * `<masterId>_<YYYYMMDD>` for an all-day series.
 */
const OCCURRENCE_ID = /^(.+)_(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})Z)?$/;

const occurrenceRefOf = (eventId: string): OccurrenceRef | undefined => {
  const match = OCCURRENCE_ID.exec(eventId);
  if (!match) {
    return undefined;
  }
  const [, masterId = '', year, month, day, hour, minute, second] = match;
  const slot = Date.UTC(
    Number(year),
    Number(month) - 1,
    Number(day),
    Number(hour ?? 0),
    Number(minute ?? 0),
    Number(second ?? 0),
  );
  return { allDay: hour === undefined, masterId, slot };
};

/** An event time as epoch ms (a date: its day at 00:00 UTC), undefined when it does not parse. */
const timeMs = (time: EventTime): number | undefined => {
  if (time?.dateTime !== undefined) {
    const ms = Date.parse(time.dateTime);
    return Number.isNaN(ms) ? undefined : ms;
  }
  if (time?.date === undefined) {
    return undefined;
  }
  try {
    return plainDateToUtcMs(time.date);
  } catch {
    return undefined;
  }
};

const isoOf = (ms: number): string => new Date(ms).toISOString().replace('.000Z', 'Z');

/**
 * A series' occurrence as Google hands it out while nothing changed it:
 * the master's fields at the occurrence's own times, under its id.
 */
const plainOccurrence = (master: GcalEvent, ref: OccurrenceRef, eventId: string): GcalEvent => {
  const { recurrence: _recurrence, ...fields } = master;
  if (ref.allDay) {
    const date = new Date(ref.slot).toISOString().slice(0, 10);
    const days =
      master.start?.date !== undefined && master.end?.date !== undefined
        ? daysBetweenPlainDates(master.start.date, master.end.date)
        : 1;
    return {
      ...fields,
      end: { date: addDaysToPlainDate(date, days) },
      id: eventId,
      originalStartTime: { date },
      recurringEventId: master.id,
      start: { date },
    };
  }
  const length = (timeMs(master.end) ?? 0) - (timeMs(master.start) ?? 0);
  const zone = master.start?.timeZone === undefined ? {} : { timeZone: master.start.timeZone };
  const start = { dateTime: isoOf(ref.slot), ...zone };
  return {
    ...fields,
    end: { dateTime: isoOf(ref.slot + length), ...zone },
    id: eventId,
    originalStartTime: start,
    recurringEventId: master.id,
    start,
  };
};

/** The fields of a master Google copies onto its exceptions when a PATCH changes them. */
const CARRIED_FIELDS = ['summary', 'description', 'location'] as const;

/**
 * PATCH semantics of start/end: nested fields merge into the stored time,
 * and one sent as null is removed — so turning a timed event all-day has
 * to null `dateTime` (and `timeZone`) explicitly. Verified on Google
 * 2026-09-24: a time with both `date` and `dateTime` is a 400 "Invalid
 * start time".
 */
const mergeEventTime = (stored: EventTime, patch: unknown): EventTime => {
  if (patch === undefined || patch === null || typeof patch !== 'object') {
    return stored;
  }
  const merged: Record<string, string | undefined> = { ...stored };
  for (const [key, value] of Object.entries(patch)) {
    if (typeof value === 'string') {
      merged[key] = value;
    } else {
      delete merged[key];
    }
  }
  return merged;
};

const invalidTime = (time: EventTime): boolean =>
  time !== undefined && time.date !== undefined && time.dateTime !== undefined;

/**
 * PATCH semantics of extendedProperties: each map merges key by key into
 * the stored one, and a key sent as null is deleted (the only way to
 * remove one). An empty map disappears like it does on Google.
 */
const mergeExtendedProperties = (
  stored: ExtendedProperties,
  patch: unknown,
): ExtendedProperties => {
  if (patch === undefined || patch === null || typeof patch !== 'object') {
    return stored;
  }
  const merged: Record<string, Record<string, string>> = {};
  for (const scope of ['private', 'shared'] as const) {
    const next: Record<string, string> = { ...stored?.[scope] };
    const changes = (patch as Record<string, unknown>)[scope];
    if (changes && typeof changes === 'object') {
      for (const [key, value] of Object.entries(changes)) {
        if (typeof value === 'string') {
          next[key] = value;
        } else {
          delete next[key];
        }
      }
    }
    if (Object.keys(next).length > 0) {
      merged[scope] = next;
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
};

/**
 * An event version's etag. Versions count per calendar (sync tokens are
 * per calendar); the etag names the calendar too, so a moved event's old
 * etag never matches another calendar's, as on Google, where etags are
 * unique.
 */
const etagOf = (calendarId: string, version: number): string => `"${calendarId}/v${version}"`;

/** A stored task on the wire: `updated` is the RFC 3339 form of its stamp. */
const wire = (entry: StoredTask): GcalTask => ({
  ...entry.task,
  updated: new Date(entry.updatedAt).toISOString(),
});

export interface FakeCall {
  /** The JSON body a write was sent with. */
  readonly body?: Record<string, unknown>;
  readonly method: string;
  readonly url: string;
}

/** What `FakeGoogle.fault` can do to one request. */
export type FakeFault = 'lost' | 'refused';

export interface FakeGoogleOptions {
  /**
   * How calendars.insert answers: 'forbidden' is an account signed in
   * before the app asked for the calendar-creation scope (403).
   */
  readonly calendarCreation?: 'allowed' | 'forbidden';
  readonly calendars: ReadonlyArray<GcalCalendarListEntry>;
  /**
   * Stamp task writes with the wall clock instead of `now`. An app running
   * against the fake pulls with a device-time `updatedMin` watermark, which
   * a frozen 2026-08-24 stamp would never clear.
   */
  readonly live?: boolean;
  /**
   * The signed-in account's address: Google makes it the organizer
   * (`self`) of an event it inserts without one, which is what lets a
   * created event be moved later. Absent, an insert stores no organizer.
   */
  readonly organizerEmail?: string;
  /** Events per list page (Google's cap is 2,500); small values exercise pagination. */
  readonly pageSize?: number;
  /** Saved contacts (people.connections); otherContacts is always empty. */
  readonly people?: ReadonlyArray<GcalPerson>;
  readonly taskLists?: ReadonlyArray<GcalTaskList>;
}

export class FakeGoogle {
  readonly requests: Array<FakeCall> = [];
  private readonly calendars: Array<GcalCalendarListEntry>;
  private readonly calendarCreation: 'allowed' | 'forbidden';
  private calendarSeq = 0;
  private readonly removedCalendars: Array<string> = [];
  private readonly pageSize: number;
  private readonly people: Array<GcalPerson>;
  private readonly taskLists: Array<GcalTaskList>;
  private readonly events = new Map<string, Map<string, StoredEvent>>();
  private readonly versions = new Map<string, number>();
  /** Sync tokens at or below this version are expired (410). */
  private readonly expiredBelow = new Map<string, number>();
  private readonly tasks = new Map<string, Map<string, StoredTask>>();
  private taskSeq = 0;
  /** epoch ms of each list's own `updated`; untouched lists answer `createdAt`. */
  private readonly listStamps = new Map<string, number>();
  private readonly createdAt: number;
  private readonly live: boolean;
  /** The fake's clock for task `updated` stamps; advance it between passes. */
  now = Date.parse('2026-08-24T10:00:00.000Z');
  /** This many `tasks.move` calls answer 503 first (a move held in backoff). */
  failTaskMoves = 0;
  /** This many task PATCH calls answer 503 first (an edit held in backoff). */
  failTaskPatches = 0;
  /** Runs as each request arrives, before it is answered: a change made elsewhere mid-pass. */
  onRequest: ((call: { readonly method: string; readonly url: string }) => void) | undefined;
  /**
   * Decides a request's fate before it reaches the routes: `refused` is a
   * 503 that changes nothing, `lost` is answered here — the write lands —
   * while the client sees the connection drop. Undefined: answered as usual.
   */
  fault: ((call: FakeCall) => FakeFault | undefined) | undefined;
  /**
   * Runs on every answer the fake gives, `lost` when the client never sees
   * it (`fault`: the connection dropped after the routes answered).
   */
  onAnswer:
    | ((
        call: FakeCall,
        answer: { readonly json: unknown; readonly lost: boolean; readonly status: number },
      ) => void)
    | undefined;
  /**
   * Requests the fake answered although Google's own answer to them is
   * not recorded (docs/google-sync-and-testing.md, the live suite): it
   * answered as it did before it knew series. A test that judges the app
   * by the fake checks that this stays empty.
   */
  readonly unverified: Array<string> = [];
  /**
   * Series a list has named gone, deleted or moved away, whose live
   * exceptions went with them, as `calendarId|masterId`. What a list
   * reports for such exceptions is not recorded: the page named the
   * series alone. A test that judges the app by the fake does not judge
   * what a client that still held them shows of them afterwards.
   */
  readonly goneWithExceptions: Array<string> = [];
  /** Per calendar, the series that left with live exceptions and no list named gone yet. */
  private readonly tookExceptions = new Map<string, Set<string>>();
  /** Exceptions (`calendarId|id`) that came with their series' move and were not written since. */
  private readonly movedAlong = new Set<string>();
  private readonly organizer: GcalEvent['organizer'];
  private lastReply: { readonly json: unknown; readonly status: number } | undefined;

  constructor(options: FakeGoogleOptions) {
    this.calendars = [...options.calendars];
    this.calendarCreation = options.calendarCreation ?? 'allowed';
    this.organizer =
      options.organizerEmail === undefined
        ? undefined
        : { email: options.organizerEmail, self: true };
    this.live = options.live ?? false;
    this.pageSize = options.pageSize ?? 2500;
    this.people = [...(options.people ?? [])];
    this.taskLists = [...(options.taskLists ?? [])];
    this.createdAt = this.stamp();
  }

  // ---- server-side mutations the tests drive ----

  putEvent(calendarId: string, event: GcalEvent): void {
    if (event.status !== 'cancelled') {
      this.tookExceptions.get(calendarId)?.delete(event.id);
    }
    this.movedAlong.delete(`${calendarId}|${event.id}`);
    const version = this.bump(calendarId);
    this.storeOf(calendarId).set(event.id, {
      event: { ...event, etag: etagOf(calendarId, version) },
      version,
    });
  }

  cancelEvent(calendarId: string, eventId: string): void {
    const version = this.bump(calendarId);
    this.storeOf(calendarId).set(eventId, {
      event: { etag: etagOf(calendarId, version), id: eventId, status: 'cancelled' },
      version,
    });
  }

  /**
   * Another device's events.patch, never with If-Match: an occurrence's id
   * makes or changes its exception, a master's does to its exceptions
   * what Google does. Throws where Google refuses.
   */
  patchEventServerSide(calendarId: string, eventId: string, changes: Partial<GcalEvent>): void {
    const answer = this.writeEvent('PATCH', calendarId, eventId, { ...changes }, undefined);
    if (answer.status >= 400) {
      throw new Error(`events.patch of ${eventId} in ${calendarId} was refused: ${answer.status}`);
    }
  }

  /**
   * Another device's events.delete, never with If-Match: an occurrence's
   * id cancels that occurrence, a master's takes its exceptions. Throws
   * where Google refuses.
   */
  deleteEventServerSide(calendarId: string, eventId: string): void {
    const answer = this.writeEvent('DELETE', calendarId, eventId, undefined, undefined);
    if (answer.status >= 400) {
      throw new Error(`events.delete of ${eventId} in ${calendarId} was refused: ${answer.status}`);
    }
  }

  /** Every token handed out so far for this calendar answers 410 from now on. */
  expireSyncTokens(calendarId: string): void {
    this.expiredBelow.set(calendarId, this.versions.get(calendarId) ?? 0);
  }

  /**
   * Stores the task as given, positions included (seeding, another
   * device's edit). The list's `updated` moves when the task is new or its
   * parent, position or completion changed, as on Google.
   */
  putTask(listId: string, task: GcalTask): void {
    const existing = this.tasksOf(listId).get(task.id)?.task;
    this.tasksOf(listId).set(task.id, { task, updatedAt: this.stamp() });
    if (
      existing === undefined ||
      existing.parent !== task.parent ||
      existing.position !== task.position ||
      existing.status !== task.status
    ) {
      this.touchList(listId);
    }
  }

  /** Another device's insert: first among its siblings, which Google renumbers. */
  insertTaskServerSide(listId: string, task: GcalTask): void {
    const store = this.tasksOf(listId);
    const entry: StoredTask = { task, updatedAt: this.stamp() };
    this.renumber(store, [entry, ...this.siblingsOf(store, task.parent, task.id)]);
    this.touchList(listId);
  }

  /**
   * Another device's `tasks.move`: to `destination` (another list), or
   * inside the list (throws where Google answers 400).
   */
  moveTaskServerSide(
    listId: string,
    taskId: string,
    place: {
      readonly destination?: string;
      readonly parent?: string;
      readonly previous?: string;
    },
  ): void {
    const existing = this.tasksOf(listId).get(taskId);
    if (!existing || existing.task.deleted) {
      throw new Error(`no task ${taskId} in ${listId}`);
    }
    if (place.destination !== undefined && place.destination !== listId) {
      this.moveToList(listId, existing, place.destination);
      return;
    }
    const refused = this.placeTask(listId, existing, place.parent ?? null, place.previous ?? null);
    if (refused !== undefined) {
      throw new Error(refused);
    }
  }

  deleteTaskServerSide(listId: string, taskId: string): void {
    const store = this.tasksOf(listId);
    const existing = store.get(taskId);
    if (existing) {
      store.set(taskId, {
        task: { ...existing.task, deleted: true },
        updatedAt: this.stamp(),
      });
      // The siblings it left close ranks (verified live).
      this.renumber(store, this.siblingsOf(store, existing.task.parent, taskId));
      this.touchList(listId);
    }
  }

  /** The list's own `updated` (tasklists.list), as epoch ms. */
  listUpdatedOf(listId: string): number {
    return this.listStamps.get(listId) ?? this.createdAt;
  }

  /**
   * The calendar disappears from calendarList: a full list no longer
   * returns it, an incremental one reports a `deleted` entry, as Google does.
   */
  removeCalendar(calendarId: string): void {
    const index = this.calendars.findIndex((entry) => entry.id === calendarId);
    if (index !== -1) {
      this.calendars.splice(index, 1);
      this.removedCalendars.push(calendarId);
    }
  }

  putPerson(person: GcalPerson): void {
    const index = this.people.findIndex((entry) => entry.resourceName === person.resourceName);
    if (index === -1) {
      this.people.push(person);
    } else {
      this.people[index] = person;
    }
  }

  eventOf(calendarId: string, eventId: string): GcalEvent | undefined {
    return this.storeOf(calendarId).get(eventId)?.event;
  }

  /** Every event the calendar holds now (deleted ones left out), in start order. */
  eventsOf(calendarId: string): Array<GcalEvent> {
    return [...this.storeOf(calendarId).values()]
      .map((entry) => entry.event)
      .filter((event) => event.status !== 'cancelled')
      .sort((a, b) =>
        (a.start?.dateTime ?? a.start?.date ?? '').localeCompare(
          b.start?.dateTime ?? b.start?.date ?? '',
        ),
      );
  }

  /** A series' exceptions as stored, cancelled ones included. */
  exceptionsOf(calendarId: string, masterId: string): Array<GcalEvent> {
    return [...this.storeOf(calendarId).values()]
      .map((entry) => entry.event)
      .filter((event) => event.recurringEventId === masterId);
  }

  /**
   * events.instances: where a series is drawn in [fromUtc, toUtc), in
   * start order — the occurrences its rule draws as the master has them
   * and its exceptions as they are, cancelled ones left out.
   */
  instancesOf(
    calendarId: string,
    masterId: string,
    fromUtc: number,
    toUtc: number,
  ): Array<GcalEvent> {
    const master = this.storeOf(calendarId).get(masterId)?.event;
    const record = master && this.recordOf(calendarId, master);
    if (!master || !record || master.status === 'cancelled' || !master.recurrence?.length) {
      return [];
    }
    const exceptions = this.exceptionsOf(calendarId, masterId);
    const taken = new Set(
      exceptions.flatMap((exception) => {
        const slot = timeMs(exception.originalStartTime);
        return slot === undefined ? [] : [slot];
      }),
    );
    let plain: Array<GcalEvent> = [];
    try {
      plain = expandRecurringEvent(recurrenceMasterOf(record), fromUtc, toUtc, taken).map(
        (instance) =>
          plainOccurrence(
            master,
            { allDay: record.isAllDay, masterId, slot: instance.originalStartUtc },
            googleInstanceId(masterId, instance.originalStartUtc, record.isAllDay),
          ),
      );
    } catch {
      // A rule that does not expand draws nothing.
    }
    const changed = exceptions.filter(
      (exception) =>
        exception.status !== 'cancelled' &&
        (timeMs(exception.start) ?? 0) < toUtc &&
        (timeMs(exception.end) ?? 0) > fromUtc,
    );
    return [...plain, ...changed].sort(
      (a, b) => (timeMs(a.start) ?? 0) - (timeMs(b.start) ?? 0) || a.id.localeCompare(b.id),
    );
  }

  taskOf(listId: string, taskId: string): GcalTask | undefined {
    return this.tasksOf(listId).get(taskId)?.task;
  }

  /** Every task the list holds now (deleted ones left out), as the wire sends them. */
  tasksIn(listId: string): Array<GcalTask> {
    return [...this.tasksOf(listId).values()].filter((entry) => !entry.task.deleted).map(wire);
  }

  /** The fake as an HttpClient: the real request core and clients run on top. */
  get httpLayer(): Layer.Layer<HttpClient.HttpClient> {
    return Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.suspend(() => this.answer(request))),
    );
  }

  /** One request through `fault` and `onAnswer` (see both). */
  private answer(
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse> {
    const call = this.callOf(request);
    const fault = this.fault?.(call);
    if (fault === 'refused') {
      this.requests.push(call);
      const json = { error: { code: 503, message: 'Backend Error' } };
      this.onAnswer?.(call, { json, lost: false, status: 503 });
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(json), {
            headers: { 'content-type': 'application/json' },
            status: 503,
          }),
        ),
      );
    }
    const response = this.handle(request);
    const answered = this.takeReply();
    if (answered !== undefined) {
      this.onAnswer?.(call, { ...answered, lost: fault === 'lost' });
    }
    return fault === 'lost'
      ? Effect.die(new Error(`connection lost after ${call.method} ${call.url} was answered`))
      : Effect.succeed(response);
  }

  /** The status and body `handle` answered with last (once). */
  private takeReply(): { readonly json: unknown; readonly status: number } | undefined {
    const answered = this.lastReply;
    this.lastReply = undefined;
    return answered;
  }

  private callOf(request: HttpClientRequest.HttpClientRequest): FakeCall {
    const url = new URL(request.url);
    // `toString` unwraps Redacted values, as the real client sends them.
    for (const [key, value] of new URLSearchParams(UrlParams.toString(request.urlParams))) {
      url.searchParams.set(key, value);
    }
    const body = this.bodyOf(request);
    return { ...(body ? { body } : {}), method: request.method, url: url.toString() };
  }

  /** HttpClient + a TokenManager that always has a token. */
  get layer(): Layer.Layer<HttpClient.HttpClient | TokenManager> {
    const tokens: TokenManagerShape = {
      exchangeCode: () => Effect.die('not used'),
      getAccessToken: () => Effect.succeed('fake-token'),
      invalidateAccessToken: () => Effect.void,
    };
    return Layer.mergeAll(this.httpLayer, Layer.succeed(TokenManager, tokens));
  }

  // ---- routing ----

  private handle(
    request: HttpClientRequest.HttpClientRequest,
  ): HttpClientResponse.HttpClientResponse {
    const call = this.callOf(request);
    const url = new URL(call.url);
    this.requests.push(call);
    this.onRequest?.(call);
    const body = this.bodyOf(request);
    const path = url.pathname;
    const reply = (status: number, json?: unknown) => {
      this.lastReply = { json, status };
      return HttpClientResponse.fromWeb(
        request,
        new Response(status === 204 ? null : JSON.stringify(json ?? {}), {
          headers: { 'content-type': 'application/json' },
          status,
        }),
      );
    };

    if (url.hostname === 'www.googleapis.com') {
      if (path === '/calendar/v3/users/me/calendarList') {
        const tombstones = url.searchParams.has('syncToken')
          ? this.removedCalendars.map((id) => ({ deleted: true, id }))
          : [];
        return reply(200, { items: [...this.calendars, ...tombstones], nextSyncToken: 'cal-sync' });
      }
      if (path === '/calendar/v3/colors') {
        return reply(200, { calendar: {} });
      }
      if (path === '/calendar/v3/calendars' && request.method === 'POST') {
        if (this.calendarCreation === 'forbidden') {
          return reply(403, {
            error: {
              code: 403,
              errors: [{ reason: 'insufficientPermissions' }],
              message: 'Request had insufficient authentication scopes.',
              status: 'PERMISSION_DENIED',
            },
          });
        }
        // A secondary calendar the account owns; it joins calendarList at once.
        this.calendarSeq += 1;
        const entry: GcalCalendarListEntry = {
          accessRole: 'owner',
          id: `created-${this.calendarSeq}@group.calendar.google.com`,
          summary: typeof body?.['summary'] === 'string' ? body['summary'] : '',
          timeZone: typeof body?.['timeZone'] === 'string' ? body['timeZone'] : 'UTC',
        };
        this.calendars.push(entry);
        return reply(200, { id: entry.id, summary: entry.summary, timeZone: entry.timeZone });
      }
      const moveMatch = /^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)\/move$/.exec(path);
      if (moveMatch && request.method === 'POST') {
        return this.moveRoute(
          decodeURIComponent(moveMatch[1]!),
          decodeURIComponent(moveMatch[2]!),
          url.searchParams.get('destination'),
          reply,
        );
      }
      const match = /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/.exec(path);
      if (match) {
        const calendarId = decodeURIComponent(match[1]!);
        const eventId = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
        return this.calendarRoute(request, url, calendarId, eventId, body, reply);
      }
    }
    if (url.hostname === 'people.googleapis.com') {
      // Every pass is answered as a full one; the engine's token handling
      // is covered by the scripted client in contacts.test.ts.
      if (path === '/v1/people/me/connections') {
        return reply(200, { connections: this.people, nextSyncToken: 'people-1' });
      }
      if (path === '/v1/otherContacts') {
        return reply(200, { nextSyncToken: 'other-1', otherContacts: [] });
      }
    }
    if (url.hostname === 'tasks.googleapis.com') {
      if (path === '/tasks/v1/users/@me/lists') {
        return reply(200, {
          items: this.taskLists.map((list) => ({
            ...list,
            updated: new Date(this.listUpdatedOf(list.id)).toISOString(),
          })),
        });
      }
      const taskMove = /^\/tasks\/v1\/lists\/([^/]+)\/tasks\/([^/]+)\/move$/.exec(path);
      if (taskMove && request.method === 'POST') {
        return this.moveTaskRoute(
          decodeURIComponent(taskMove[1]!),
          decodeURIComponent(taskMove[2]!),
          {
            destination: url.searchParams.get('destinationTasklist'),
            parent: url.searchParams.get('parent'),
            previous: url.searchParams.get('previous'),
          },
          reply,
        );
      }
      const match = /^\/tasks\/v1\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/.exec(path);
      if (match) {
        const listId = decodeURIComponent(match[1]!);
        const taskId = match[2] === undefined ? undefined : decodeURIComponent(match[2]);
        return this.tasksRoute(request, url, listId, taskId, body, reply);
      }
    }
    return reply(404, { error: { message: `no fake route for ${request.method} ${path}` } });
  }

  /** events.list: a full list, or what changed since a sync token (410 once it expired), in pages. */
  private listRoute(
    calendarId: string,
    url: URL,
    reply: (status: number, json?: unknown) => HttpClientResponse.HttpClientResponse,
  ): HttpClientResponse.HttpClientResponse {
    const store = this.storeOf(calendarId);
    const syncToken = url.searchParams.get('syncToken');
    // A token handed out after an expiry is good even when nothing was
    // written since: it must not read as one of the expired ones.
    const current =
      syncToken === null &&
      (this.expiredBelow.get(calendarId) ?? -1) >= (this.versions.get(calendarId) ?? 0)
        ? this.bump(calendarId)
        : (this.versions.get(calendarId) ?? 0);
    let items: Array<GcalEvent>;
    if (syncToken !== null) {
      const since = Number(syncToken.split(':')[1] ?? Number.NaN);
      if (!Number.isFinite(since) || since <= (this.expiredBelow.get(calendarId) ?? -1)) {
        return reply(410, { error: { message: 'Sync token is no longer valid' } });
      }
      items = [...store.values()]
        .filter((entry) => entry.version > since)
        .map((entry) => entry.event);
      // What a list reports for the exceptions that went with a series
      // is not recorded: it names the series alone, and says so.
      const left = this.tookExceptions.get(calendarId);
      for (const item of items) {
        if (item.status === 'cancelled' && left?.delete(item.id)) {
          this.goneWithExceptions.push(`${calendarId}|${item.id}`);
        }
      }
    } else {
      // A full list names neither: a client drops what it does not name.
      this.tookExceptions.delete(calendarId);
      // A full list: no timeMin is honoured because the engine never
      // sends one — every event ever, like Google without a window. A
      // series' cancelled occurrences come with it (the tombstones a full
      // pull brings), a deleted event does not.
      items = [...store.values()]
        .filter(
          (entry) =>
            entry.event.status !== 'cancelled' ||
            (entry.event.recurringEventId !== undefined &&
              this.seriesOf(calendarId, entry.event.recurringEventId) !== undefined),
        )
        .map((entry) => entry.event);
    }
    // Pages like Google: the sync token only rides on the last one.
    const offset = Number(url.searchParams.get('pageToken') ?? 0);
    const pageItems = items.slice(offset, offset + this.pageSize);
    const next = offset + this.pageSize;
    return reply(
      200,
      next < items.length
        ? { items: pageItems, nextPageToken: String(next) }
        : { items: pageItems, nextSyncToken: `${calendarId}:${current}` },
    );
  }

  private calendarRoute(
    request: HttpClientRequest.HttpClientRequest,
    url: URL,
    calendarId: string,
    eventId: string | undefined,
    body: Record<string, unknown> | undefined,
    reply: (status: number, json?: unknown) => HttpClientResponse.HttpClientResponse,
  ): HttpClientResponse.HttpClientResponse {
    const store = this.storeOf(calendarId);
    if (request.method === 'GET' && eventId === undefined) {
      return this.listRoute(calendarId, url, reply);
    }
    if (request.method === 'POST' && eventId === undefined) {
      const id = typeof body?.['id'] === 'string' ? body['id'] : `srv-${this.bump(calendarId)}`;
      // An id stays taken for good — by a live event and by a deleted one
      // alike (verified live 2026-10-02).
      if (store.has(id)) {
        return reply(409, {
          error: {
            code: 409,
            errors: [{ reason: 'duplicate' }],
            message: 'The requested identifier already exists.',
          },
        });
      }
      const inserted = body as GcalEvent;
      this.putEvent(calendarId, {
        ...inserted,
        id,
        ...(inserted.organizer === undefined && this.organizer !== undefined
          ? { organizer: this.organizer }
          : {}),
      });
      return reply(200, this.eventOf(calendarId, id));
    }
    if (eventId !== undefined) {
      const answer = this.writeEvent(
        request.method,
        calendarId,
        eventId,
        body,
        request.headers['if-match'],
      );
      return reply(answer.status, answer.json);
    }
    return reply(405);
  }

  /**
   * One event by its id: events.get, patch, update and delete, as a
   * request sends them or as another device does (no If-Match).
   */
  private writeEvent(
    method: string,
    calendarId: string,
    eventId: string,
    body: Record<string, unknown> | undefined,
    ifMatch: string | undefined,
  ): Answer {
    const store = this.storeOf(calendarId);
    const occurrence = this.occurrenceAt(calendarId, eventId);
    if (occurrence !== undefined && method === 'PUT') {
      this.unverified.push(`events.update of ${eventId}, one occurrence of a series`);
    } else if (occurrence !== undefined) {
      return this.writeOccurrence(method, calendarId, eventId, occurrence, body, ifMatch);
    }
    const existing = store.get(eventId);
    // events.update with `status: 'confirmed'` is the one write a deleted
    // event accepts: it comes back under its id (verified live 2026-10-02).
    const revives =
      method === 'PUT' &&
      existing?.event.status === 'cancelled' &&
      body?.['status'] === 'confirmed';
    if (!existing || (existing.event.status === 'cancelled' && !revives)) {
      return { json: { error: { message: 'Not Found' } }, status: 404 };
    }
    if (method === 'GET') {
      return { json: this.eventOf(calendarId, eventId), status: 200 };
    }
    if (ifMatch !== undefined && ifMatch !== existing.event.etag) {
      return { json: { error: { message: 'Precondition Failed' } }, status: 412 };
    }
    if (method === 'PATCH') {
      const start = mergeEventTime(existing.event.start, body?.['start']);
      const end = mergeEventTime(existing.event.end, body?.['end']);
      if (invalidTime(start) || invalidTime(end)) {
        return { json: { error: { code: 400, message: 'Invalid start time.' } }, status: 400 };
      }
      this.putEvent(calendarId, {
        ...existing.event,
        ...(body as Partial<GcalEvent>),
        end,
        extendedProperties: mergeExtendedProperties(
          existing.event.extendedProperties,
          body?.['extendedProperties'],
        ),
        id: eventId,
        start,
      });
      const patched = this.eventOf(calendarId, eventId)!;
      this.patchExceptions(calendarId, existing.event, patched);
      return { json: patched, status: 200 };
    }
    if (method === 'PUT') {
      // A full replace: whatever the body leaves out is gone, extended
      // properties included — no merge, unlike PATCH.
      const next = body as GcalEvent;
      if (invalidTime(next.start) || invalidTime(next.end)) {
        return { json: { error: { code: 400, message: 'Invalid start time.' } }, status: 400 };
      }
      if (this.exceptionsOf(calendarId, eventId).length > 0) {
        this.unverified.push(`events.update of ${eventId}, a series with exceptions`);
      }
      this.putEvent(calendarId, { ...next, id: eventId });
      return { json: this.eventOf(calendarId, eventId), status: 200 };
    }
    if (method === 'DELETE') {
      this.cancelEvent(calendarId, eventId);
      this.takeExceptions(calendarId, eventId);
      return { status: 204 };
    }
    return { status: 405 };
  }

  /**
   * The occurrence a request's id names, where this calendar holds its
   * series: the master, and the exception when one is stored.
   */
  private occurrenceAt(
    calendarId: string,
    eventId: string,
  ):
    | {
        readonly exception: GcalEvent | undefined;
        readonly master: GcalEvent;
        readonly ref: OccurrenceRef;
      }
    | undefined {
    const ref = occurrenceRefOf(eventId);
    if (ref === undefined) {
      return undefined;
    }
    const store = this.storeOf(calendarId);
    const master = store.get(ref.masterId)?.event;
    const exception = store.get(eventId)?.event;
    if (!master || master.status === 'cancelled') {
      return undefined;
    }
    // An event that only looks like one (no series by that name, or an
    // event of its own under the id) is answered as any other.
    if (exception ? exception.recurringEventId !== ref.masterId : !master.recurrence?.length) {
      return undefined;
    }
    return { exception, master, ref };
  }

  /**
   * events.get, patch and delete of one occurrence. A PATCH makes the
   * exception, or changes it, and leaves the master's etag alone; a
   * DELETE cancels the occurrence, with or without an exception stored;
   * one already cancelled answers a DELETE with 410. A stale If-Match is
   * a 412 before any of that. A slot the series does not draw is no event.
   */
  private writeOccurrence(
    method: string,
    calendarId: string,
    eventId: string,
    occurrence: {
      readonly exception: GcalEvent | undefined;
      readonly master: GcalEvent;
      readonly ref: OccurrenceRef;
    },
    body: Record<string, unknown> | undefined,
    ifMatch: string | undefined,
  ): Answer {
    const { exception, master, ref } = occurrence;
    if (exception === undefined && !this.draws(calendarId, master, ref.slot)) {
      return { json: { error: { message: 'Not Found' } }, status: 404 };
    }
    const current = exception ?? plainOccurrence(master, ref, eventId);
    if (method === 'GET') {
      return { json: current, status: 200 };
    }
    if (ifMatch !== undefined && ifMatch !== current.etag) {
      // events.move gives the event a new etag; whether its exceptions get
      // one too is not recorded. Here they do, as every moved event.
      if (this.movedAlong.has(`${calendarId}|${eventId}`)) {
        this.unverified.push(`${method} of ${eventId} on its etag from before its series moved`);
      }
      return { json: { error: { message: 'Precondition Failed' } }, status: 412 };
    }
    if (ifMatch !== undefined && exception === undefined) {
      this.unverified.push(`${method} of ${eventId} with If-Match, no exception stored`);
    }
    const cancelled = current.status === 'cancelled';
    if (method === 'DELETE') {
      if (cancelled) {
        return { json: { error: { message: 'Resource has been deleted' } }, status: 410 };
      }
      this.putEvent(calendarId, {
        id: eventId,
        originalStartTime: current.originalStartTime,
        recurringEventId: ref.masterId,
        status: 'cancelled',
      });
      return { status: 204 };
    }
    if (method !== 'PATCH') {
      return { status: 405 };
    }
    if (cancelled) {
      // What Google does with a PATCH of a cancelled occurrence is not
      // recorded: answered as a deleted event always was here.
      this.unverified.push(`events.patch of ${eventId}, a cancelled occurrence`);
      return { json: { error: { message: 'Not Found' } }, status: 404 };
    }
    const start = mergeEventTime(current.start, body?.['start']);
    const end = mergeEventTime(current.end, body?.['end']);
    if (invalidTime(start) || invalidTime(end)) {
      return { json: { error: { code: 400, message: 'Invalid start time.' } }, status: 400 };
    }
    const { recurrence: _recurrence, ...changes } = (body ?? {}) as Partial<GcalEvent>;
    this.putEvent(calendarId, {
      ...current,
      ...changes,
      end,
      extendedProperties: mergeExtendedProperties(
        current.extendedProperties,
        body?.['extendedProperties'],
      ),
      id: eventId,
      originalStartTime: current.originalStartTime,
      recurringEventId: ref.masterId,
      start,
    });
    return { json: this.eventOf(calendarId, eventId), status: 200 };
  }

  /**
   * What a PATCH of a master does to its exceptions (verified live, see
   * docs/google-sync-and-testing.md): each gets a new etag and `updated`;
   * a title, description or location the PATCH changed is copied onto
   * them, their own values included, while a field sent with its old
   * value leaves theirs alone; and the rule it leaves keeps an exception
   * whose slot it still draws as it was, moved or cancelled, and cancels
   * the others.
   */
  private patchExceptions(calendarId: string, before: GcalEvent, after: GcalEvent): void {
    const exceptions = this.exceptionsOf(calendarId, after.id);
    if (exceptions.length === 0) {
      return;
    }
    const updated = new Date(this.stamp()).toISOString();
    const carried = Object.fromEntries(
      CARRIED_FIELDS.filter((field) => (after[field] ?? '') !== (before[field] ?? '')).map(
        (field) => [field, after[field]],
      ),
    );
    // No rule left cancels them all. Where the exceptions of a series
    // that keeps one go when its times change is not recorded: they stay
    // as they are.
    const cleared = !after.recurrence?.length;
    const was = this.recordOf(calendarId, before);
    const now = this.recordOf(calendarId, after);
    const retimed =
      !cleared &&
      (was?.startUtc !== now?.startUtc ||
        was?.endUtc !== now?.endUtc ||
        was?.startTimeZone !== now?.startTimeZone);
    if (retimed) {
      this.unverified.push(`events.patch of ${after.id}: new times for a series with exceptions`);
    }
    for (const exception of exceptions) {
      const tombstone = {
        id: exception.id,
        originalStartTime: exception.originalStartTime,
        recurringEventId: after.id,
        status: 'cancelled',
        updated,
      };
      const slot = timeMs(exception.originalStartTime);
      const drawn =
        !cleared && (retimed || (slot !== undefined && this.draws(calendarId, after, slot)));
      const wasDrawn = retimed || (slot !== undefined && this.draws(calendarId, before, slot));
      if (!drawn) {
        this.putEvent(calendarId, tombstone);
      } else if (!wasDrawn) {
        // A slot an earlier rule dropped and this one draws again is a
        // plain occurrence (verified live); what a list then reports for
        // it is not recorded, and nothing is reported here.
        this.unverified.push(`events.patch of ${after.id}: its rule draws ${exception.id} again`);
        this.storeOf(calendarId).delete(exception.id);
      } else if (exception.status === 'cancelled') {
        this.putEvent(calendarId, tombstone);
      } else {
        this.putEvent(calendarId, { ...exception, ...carried, updated });
      }
    }
  }

  /**
   * A series leaves the calendar, deleted or moved away, and its
   * exceptions with it: the live ones are gone from here, one cancelled
   * before stays the tombstone it was. Returns them as they were.
   */
  private takeExceptions(calendarId: string, masterId: string): Array<GcalEvent> {
    const exceptions = this.exceptionsOf(calendarId, masterId);
    const live = exceptions.filter((exception) => exception.status !== 'cancelled');
    for (const exception of live) {
      this.storeOf(calendarId).delete(exception.id);
    }
    if (live.length > 0) {
      const left = this.tookExceptions.get(calendarId) ?? new Set();
      this.tookExceptions.set(calendarId, left.add(masterId));
    }
    return exceptions;
  }

  /** The series by that id: a live event with a rule. */
  private seriesOf(calendarId: string, masterId: string): GcalEvent | undefined {
    const master = this.storeOf(calendarId).get(masterId)?.event;
    return master && master.status !== 'cancelled' && master.recurrence?.length
      ? master
      : undefined;
  }

  /** The event as the app's own mapping reads it, for core's expansion. */
  private recordOf(calendarId: string, event: GcalEvent) {
    return mapGcalEvent(event, {
      accountId: '',
      calendarId,
      defaultTimeZone: this.calendars.find((entry) => entry.id === calendarId)?.timeZone ?? 'UTC',
      syncedAt: 0,
    });
  }

  /** Whether the master's rule draws an occurrence at `slot`; a rule that does not expand draws nothing. */
  private draws(calendarId: string, master: GcalEvent, slot: number): boolean {
    const record = master.recurrence?.length ? this.recordOf(calendarId, master) : null;
    if (!record) {
      return false;
    }
    try {
      return expandRecurringEvent(recurrenceMasterOf(record), slot - 1, slot + 1).some(
        (instance) => instance.originalStartUtc === slot,
      );
    } catch {
      return false;
    }
  }

  /**
   * events.move: the event leaves the source (a cancelled tombstone for
   * its sync token) and appears in the destination under the same id,
   * a series with its exceptions. Organizer only, whole events only — an
   * instance id is refused.
   */
  private moveRoute(
    calendarId: string,
    eventId: string,
    destination: string | null,
    reply: (status: number, json?: unknown) => HttpClientResponse.HttpClientResponse,
  ): HttpClientResponse.HttpClientResponse {
    const existing = this.storeOf(calendarId).get(eventId);
    if (!existing || existing.event.status === 'cancelled') {
      return reply(404, { error: { message: 'Not Found' } });
    }
    if (destination === null || !this.calendars.some((entry) => entry.id === destination)) {
      return reply(404, { error: { message: 'Destination calendar not found' } });
    }
    if (/_\d{8}(T\d{6}Z)?$/.test(eventId)) {
      return reply(400, { error: { message: 'Cannot move an instance of a recurring event' } });
    }
    if (existing.event.organizer?.self !== true) {
      return reply(403, {
        error: { errors: [{ reason: 'forbiddenForNonOrganizer' }], message: 'Forbidden' },
      });
    }
    this.cancelEvent(calendarId, eventId);
    this.putEvent(destination, existing.event);
    // A series' exceptions go with it, cancelled ones too.
    for (const exception of this.takeExceptions(calendarId, eventId)) {
      this.putEvent(destination, exception);
      this.movedAlong.add(`${destination}|${exception.id}`);
    }
    return reply(200, this.eventOf(destination, eventId));
  }

  private tasksRoute(
    request: HttpClientRequest.HttpClientRequest,
    url: URL,
    listId: string,
    taskId: string | undefined,
    body: Record<string, unknown> | undefined,
    reply: (status: number, json?: unknown) => HttpClientResponse.HttpClientResponse,
  ): HttpClientResponse.HttpClientResponse {
    const store = this.tasksOf(listId);
    if (request.method === 'GET' && taskId === undefined) {
      const updatedMin = url.searchParams.get('updatedMin');
      const since = updatedMin === null ? null : Date.parse(updatedMin);
      const items = [...store.values()]
        .filter((entry) => (since === null ? !entry.task.deleted : entry.updatedAt >= since))
        .map(wire);
      return reply(200, { items });
    }
    if (request.method === 'POST' && taskId === undefined) {
      this.taskSeq += 1;
      const id = `task-${this.taskSeq}`;
      const parent = url.searchParams.get('parent');
      if (parent !== null && !store.get(parent)) {
        return reply(400, { error: { message: 'Invalid parent' } });
      }
      const task: GcalTask = {
        status: 'needsAction',
        ...(body as Partial<GcalTask>),
        id,
        ...(parent === null ? {} : { parent }),
      };
      // First among its siblings; they are renumbered, their `updated`
      // stays (verified live).
      this.renumber(store, [
        { task, updatedAt: this.stamp() },
        ...this.siblingsOf(store, task.parent, id),
      ]);
      this.touchList(listId);
      return reply(200, wire(store.get(id)!));
    }
    if (taskId !== undefined) {
      const existing = store.get(taskId);
      if (!existing || existing.task.deleted) {
        return reply(404, { error: { message: 'Not Found' } });
      }
      if (request.method === 'PATCH') {
        if (this.failTaskPatches > 0) {
          this.failTaskPatches -= 1;
          return reply(503, { error: { message: 'Backend Error' } });
        }
        // JSON null clears a field, as on Google (`due`, `completed`).
        const patched = { ...existing.task, ...(body as Partial<GcalTask>), id: taskId };
        for (const [key, value] of Object.entries(patched)) {
          if (value === null) {
            delete (patched as Record<string, unknown>)[key];
          }
        }
        const updatedAt = this.stamp();
        // Google stamps `completed` itself when a task is completed (the
        // client sends only the status), and reopening clears it above.
        if (
          patched.status === 'completed' &&
          existing.task.status !== 'completed' &&
          patched.completed === undefined
        ) {
          patched.completed = new Date(updatedAt).toISOString();
        }
        store.set(taskId, { task: patched, updatedAt });
        // A completion moves the list's `updated`; a title, notes or due
        // edit does not (verified live for title, notes and completion).
        if (patched.status !== existing.task.status) {
          this.touchList(listId);
        }
        return reply(200, wire(store.get(taskId)!));
      }
      if (request.method === 'DELETE') {
        // Google deletes a parent's subtasks with it (verified live).
        for (const [childId, child] of store) {
          if (child.task.parent === taskId) {
            this.deleteTaskServerSide(listId, childId);
          }
        }
        this.deleteTaskServerSide(listId, taskId);
        return reply(204);
      }
    }
    return reply(405);
  }

  /**
   * `tasks.move` to another list, as verified live: the task keeps its
   * id and leaves its parent; its subtasks come along, still nested; the
   * source list lists none of them afterwards — not even as tombstones —
   * and answers 404 for them.
   */
  private moveTaskRoute(
    listId: string,
    taskId: string,
    params: {
      readonly destination: string | null;
      readonly parent: string | null;
      readonly previous: string | null;
    },
    reply: (status: number, json?: unknown) => HttpClientResponse.HttpClientResponse,
  ): HttpClientResponse.HttpClientResponse {
    if (this.failTaskMoves > 0) {
      this.failTaskMoves -= 1;
      return reply(503, { error: { message: 'Backend Error' } });
    }
    const source = this.tasksOf(listId);
    const existing = source.get(taskId);
    if (!existing || existing.task.deleted) {
      return reply(404, { error: { message: 'Task not found.' } });
    }
    const { destination } = params;
    if (destination === null || destination === listId) {
      return this.placeTaskRoute(listId, existing, params.parent, params.previous, reply);
    }
    this.moveToList(listId, existing, destination);
    return reply(200, wire(this.tasksOf(destination).get(taskId)!));
  }

  /** The move to another list itself (see moveTaskRoute). */
  private moveToList(listId: string, existing: StoredTask, destination: string): void {
    const source = this.tasksOf(listId);
    const target = this.tasksOf(destination);
    const taskId = existing.task.id;
    const { parent: formerParent, ...task } = existing.task;
    target.set(taskId, { task, updatedAt: this.stamp() });
    source.delete(taskId);
    for (const [childId, child] of source) {
      if (child.task.parent === taskId) {
        target.set(childId, { task: child.task, updatedAt: this.stamp() });
        source.delete(childId);
      }
    }
    this.renumber(source, this.siblingsOf(source, formerParent, taskId));
    this.touchList(listId);
    this.touchList(destination);
  }

  /**
   * `tasks.move` inside a list, as verified live: the task goes under
   * `parent` (none: the top level) right after `previous`, which must be
   * one of those siblings (else 400); both sibling groups are renumbered
   * as 20-digit ordinals and no `updated` changes but the list's. Google
   * takes any depth.
   */
  private placeTaskRoute(
    listId: string,
    existing: StoredTask,
    parent: string | null,
    previous: string | null,
    reply: (status: number, json?: unknown) => HttpClientResponse.HttpClientResponse,
  ): HttpClientResponse.HttpClientResponse {
    const refused = this.placeTask(listId, existing, parent, previous);
    return refused === undefined
      ? reply(200, wire(this.tasksOf(listId).get(existing.task.id)!))
      : reply(400, { error: { message: refused } });
  }

  /** The move itself; the 400 message when Google would refuse it. */
  private placeTask(
    listId: string,
    existing: StoredTask,
    parent: string | null,
    previous: string | null,
  ): string | undefined {
    const store = this.tasksOf(listId);
    const taskId = existing.task.id;
    const parentEntry = parent === null ? undefined : store.get(parent);
    if (parent === taskId || (parent !== null && (!parentEntry || parentEntry.task.deleted))) {
      return 'Invalid Value';
    }
    const target = this.siblingsOf(store, parent ?? undefined, taskId);
    const after = previous === null ? -1 : target.findIndex((entry) => entry.task.id === previous);
    if (previous !== null && after < 0) {
      return 'Invalid task id';
    }
    const { parent: formerParent, ...rest } = existing.task;
    const moved: StoredTask = {
      task: { ...rest, ...(parent === null ? {} : { parent }) },
      updatedAt: existing.updatedAt,
    };
    this.renumber(store, [...target.slice(0, after + 1), moved, ...target.slice(after + 1)]);
    if (formerParent !== (parent ?? undefined)) {
      this.renumber(store, this.siblingsOf(store, formerParent, taskId));
    }
    this.touchList(listId);
    return undefined;
  }

  /** The live tasks under `parentId` (absent: the top level) but `exceptId`, in position order. */
  private siblingsOf(
    store: Map<string, StoredTask>,
    parentId: string | undefined,
    exceptId: string,
  ): Array<StoredTask> {
    return [...store.values()]
      .filter(
        (entry) =>
          !entry.task.deleted && entry.task.id !== exceptId && entry.task.parent === parentId,
      )
      .sort((a, b) => {
        const left = a.task.position ?? '~';
        const right = b.task.position ?? '~';
        return left < right ? -1 : left > right ? 1 : a.task.id.localeCompare(b.task.id);
      });
  }

  /** One sibling group, numbered in this order as Google's 20-digit ordinals; `updated` stays. */
  private renumber(store: Map<string, StoredTask>, entries: ReadonlyArray<StoredTask>): void {
    entries.forEach((entry, index) => {
      store.set(entry.task.id, {
        ...entry,
        task: { ...entry.task, position: String(index).padStart(20, '0') },
      });
    });
  }

  /** The list's own `updated` moves: strictly later, even on a frozen clock. */
  private touchList(listId: string): void {
    this.listStamps.set(listId, Math.max(this.stamp(), this.listUpdatedOf(listId) + 1));
  }

  // ---- helpers ----

  private stamp(): number {
    return this.live ? Date.now() : this.now;
  }

  private bump(calendarId: string): number {
    const next = (this.versions.get(calendarId) ?? 0) + 1;
    this.versions.set(calendarId, next);
    return next;
  }

  private storeOf(calendarId: string): Map<string, StoredEvent> {
    let store = this.events.get(calendarId);
    if (!store) {
      store = new Map();
      this.events.set(calendarId, store);
    }
    return store;
  }

  private tasksOf(listId: string): Map<string, StoredTask> {
    let store = this.tasks.get(listId);
    if (!store) {
      store = new Map();
      this.tasks.set(listId, store);
    }
    return store;
  }

  private bodyOf(
    request: HttpClientRequest.HttpClientRequest,
  ): Record<string, unknown> | undefined {
    const body = request.body as { readonly _tag: string; readonly body?: Uint8Array };
    if (body._tag !== 'Uint8Array' || !body.body) {
      return undefined;
    }
    return JSON.parse(new TextDecoder().decode(body.body)) as Record<string, unknown>;
  }
}
