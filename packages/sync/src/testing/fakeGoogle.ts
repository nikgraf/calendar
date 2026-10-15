import type {
  GcalCalendarListEntry,
  GcalEvent,
  GcalPerson,
  GcalTask,
  GcalTaskList,
} from '@calendar/google';
import { TokenManager, type TokenManagerShape } from '@calendar/google';
import { Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/http';

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
  return merged as EventTime;
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

/** A stored task on the wire: `updated` is the RFC 3339 form of its stamp. */
const wire = (entry: StoredTask): GcalTask => ({
  ...entry.task,
  updated: new Date(entry.updatedAt).toISOString(),
});

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
  /** Events per list page (Google's cap is 2,500); small values exercise pagination. */
  readonly pageSize?: number;
  /** Saved contacts (people.connections); otherContacts is always empty. */
  readonly people?: ReadonlyArray<GcalPerson>;
  readonly taskLists?: ReadonlyArray<GcalTaskList>;
}

export class FakeGoogle {
  readonly requests: Array<{ readonly method: string; readonly url: string }> = [];
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

  constructor(options: FakeGoogleOptions) {
    this.calendars = [...options.calendars];
    this.calendarCreation = options.calendarCreation ?? 'allowed';
    this.live = options.live ?? false;
    this.pageSize = options.pageSize ?? 2500;
    this.people = [...(options.people ?? [])];
    this.taskLists = [...(options.taskLists ?? [])];
    this.createdAt = this.stamp();
  }

  // ---- server-side mutations the tests drive ----

  putEvent(calendarId: string, event: GcalEvent): void {
    const version = this.bump(calendarId);
    this.storeOf(calendarId).set(event.id, {
      event: { ...event, etag: `"v${version}"` },
      version,
    });
  }

  cancelEvent(calendarId: string, eventId: string): void {
    const version = this.bump(calendarId);
    this.storeOf(calendarId).set(eventId, {
      event: { etag: `"v${version}"`, id: eventId, status: 'cancelled' },
      version,
    });
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

  taskOf(listId: string, taskId: string): GcalTask | undefined {
    return this.tasksOf(listId).get(taskId)?.task;
  }

  /** The fake as an HttpClient: the real request core and clients run on top. */
  get httpLayer(): Layer.Layer<HttpClient.HttpClient> {
    return Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.sync(() => this.handle(request))),
    );
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
    const url = new URL(request.url);
    for (const [key, value] of request.urlParams.params) {
      url.searchParams.set(key, value);
    }
    const call = { method: request.method, url: url.toString() };
    this.requests.push(call);
    this.onRequest?.(call);
    const body = this.bodyOf(request);
    const path = url.pathname;
    const reply = (status: number, json?: unknown) =>
      HttpClientResponse.fromWeb(
        request,
        new Response(status === 204 ? null : JSON.stringify(json ?? {}), {
          headers: { 'content-type': 'application/json' },
          status,
        }),
      );

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
      const syncToken = url.searchParams.get('syncToken');
      const current = this.versions.get(calendarId) ?? 0;
      let items: Array<GcalEvent>;
      if (syncToken !== null) {
        const since = Number(syncToken.split(':')[1] ?? Number.NaN);
        if (!Number.isFinite(since) || since <= (this.expiredBelow.get(calendarId) ?? -1)) {
          return reply(410, { error: { message: 'Sync token is no longer valid' } });
        }
        items = [...store.values()]
          .filter((entry) => entry.version > since)
          .map((entry) => entry.event);
      } else {
        // A full list: no timeMin is honoured because the engine never
        // sends one — every event ever, like Google without a window.
        items = [...store.values()]
          .filter((entry) => entry.event.status !== 'cancelled')
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
      this.putEvent(calendarId, { ...(body as GcalEvent), id });
      return reply(200, this.eventOf(calendarId, id));
    }
    if (eventId !== undefined) {
      const existing = store.get(eventId);
      // events.update with `status: 'confirmed'` is the one write a deleted
      // event accepts: it comes back under its id (verified live 2026-10-02).
      const revives =
        request.method === 'PUT' &&
        existing?.event.status === 'cancelled' &&
        body?.['status'] === 'confirmed';
      if (!existing || (existing.event.status === 'cancelled' && !revives)) {
        return reply(404, { error: { message: 'Not Found' } });
      }
      if (request.method === 'GET') {
        return reply(200, this.eventOf(calendarId, eventId));
      }
      const ifMatch = request.headers['if-match'];
      if (ifMatch !== undefined && ifMatch !== existing.event.etag) {
        return reply(412, { error: { message: 'Precondition Failed' } });
      }
      if (request.method === 'PATCH') {
        const start = mergeEventTime(existing.event.start, body?.['start']);
        const end = mergeEventTime(existing.event.end, body?.['end']);
        if (invalidTime(start) || invalidTime(end)) {
          return reply(400, { error: { code: 400, message: 'Invalid start time.' } });
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
        return reply(200, this.eventOf(calendarId, eventId));
      }
      if (request.method === 'PUT') {
        // A full replace: whatever the body leaves out is gone, extended
        // properties included — no merge, unlike PATCH.
        const next = body as GcalEvent;
        if (invalidTime(next.start) || invalidTime(next.end)) {
          return reply(400, { error: { code: 400, message: 'Invalid start time.' } });
        }
        this.putEvent(calendarId, { ...next, id: eventId });
        return reply(200, this.eventOf(calendarId, eventId));
      }
      if (request.method === 'DELETE') {
        this.cancelEvent(calendarId, eventId);
        return reply(204);
      }
    }
    return reply(405);
  }

  /**
   * events.move: the event leaves the source (a cancelled tombstone for
   * its sync token) and appears in the destination under the same id.
   * Organizer only, whole events only — an instance id is refused.
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
        store.set(taskId, { task: patched, updatedAt: this.stamp() });
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
