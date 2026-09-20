import type {
  GcalCalendarListEntry,
  GcalEvent,
  GcalPerson,
  GcalTask,
  GcalTaskList,
} from '@calendar/google';
import { TokenManager, type TokenManagerShape } from '@calendar/google';
import { Effect, Layer } from 'effect';
import { HttpClient, HttpClientResponse, type HttpClientRequest } from 'effect/unstable/http';

/**
 * An in-process Google (Calendar + Tasks) behind effect's HttpClient, so
 * the real clients, request core and sync engine run against something
 * that answers like the API: sync tokens that go stale (410), cancelled
 * tombstones, If-Match → 412, server-assigned task ids, the updatedMin
 * watermark with deleted tombstones. Every semantic here mirrors
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
  readonly calendars: ReadonlyArray<GcalCalendarListEntry>;
  /** Events per list page (Google's cap is 2,500); small values exercise pagination. */
  readonly pageSize?: number;
  /** Saved contacts (people.connections); otherContacts is always empty. */
  readonly people?: ReadonlyArray<GcalPerson>;
  readonly taskLists?: ReadonlyArray<GcalTaskList>;
}

export class FakeGoogle {
  readonly requests: Array<{ readonly method: string; readonly url: string }> = [];
  private readonly calendars: Array<GcalCalendarListEntry>;
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
  /** The fake's clock for task `updated` stamps; advance it between passes. */
  now = Date.parse('2026-08-24T10:00:00.000Z');

  constructor(options: FakeGoogleOptions) {
    this.calendars = [...options.calendars];
    this.pageSize = options.pageSize ?? 2500;
    this.people = [...(options.people ?? [])];
    this.taskLists = [...(options.taskLists ?? [])];
  }

  // ---- server-side mutations the tests drive ----

  putEvent(calendarId: string, event: GcalEvent): void {
    const version = this.bump(calendarId);
    this.eventsOf(calendarId).set(event.id, {
      event: { ...event, etag: `"v${version}"` },
      version,
    });
  }

  cancelEvent(calendarId: string, eventId: string): void {
    const version = this.bump(calendarId);
    this.eventsOf(calendarId).set(eventId, {
      event: { etag: `"v${version}"`, id: eventId, status: 'cancelled' },
      version,
    });
  }

  /** Every token handed out so far for this calendar answers 410 from now on. */
  expireSyncTokens(calendarId: string): void {
    this.expiredBelow.set(calendarId, this.versions.get(calendarId) ?? 0);
  }

  putTask(listId: string, task: GcalTask): void {
    this.tasksOf(listId).set(task.id, { task, updatedAt: this.now });
  }

  deleteTaskServerSide(listId: string, taskId: string): void {
    const existing = this.tasksOf(listId).get(taskId);
    if (existing) {
      this.tasksOf(listId).set(taskId, {
        task: { ...existing.task, deleted: true },
        updatedAt: this.now,
      });
    }
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
    return this.eventsOf(calendarId).get(eventId)?.event;
  }

  taskOf(listId: string, taskId: string): GcalTask | undefined {
    return this.tasksOf(listId).get(taskId)?.task;
  }

  /** HttpClient + a TokenManager that always has a token. */
  get layer(): Layer.Layer<HttpClient.HttpClient | TokenManager> {
    const tokens: TokenManagerShape = {
      exchangeCode: () => Effect.die('not used'),
      getAccessToken: () => Effect.succeed('fake-token'),
      invalidateAccessToken: () => Effect.void,
    };
    return Layer.mergeAll(
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) => Effect.sync(() => this.handle(request))),
      ),
      Layer.succeed(TokenManager, tokens),
    );
  }

  // ---- routing ----

  private handle(
    request: HttpClientRequest.HttpClientRequest,
  ): HttpClientResponse.HttpClientResponse {
    const url = new URL(request.url);
    for (const [key, value] of request.urlParams.params) {
      url.searchParams.set(key, value);
    }
    this.requests.push({ method: request.method, url: url.toString() });
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
        return reply(200, { items: this.taskLists });
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
    const store = this.eventsOf(calendarId);
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
      this.putEvent(calendarId, { ...(body as GcalEvent), id });
      return reply(200, this.eventOf(calendarId, id));
    }
    if (eventId !== undefined) {
      const existing = store.get(eventId);
      if (!existing || existing.event.status === 'cancelled') {
        return reply(404, { error: { message: 'Not Found' } });
      }
      const ifMatch = request.headers['if-match'];
      if (ifMatch !== undefined && ifMatch !== existing.event.etag) {
        return reply(412, { error: { message: 'Precondition Failed' } });
      }
      if (request.method === 'PATCH') {
        this.putEvent(calendarId, {
          ...existing.event,
          ...(body as Partial<GcalEvent>),
          extendedProperties: mergeExtendedProperties(
            existing.event.extendedProperties,
            body?.['extendedProperties'],
          ),
          id: eventId,
        });
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
    const existing = this.eventsOf(calendarId).get(eventId);
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
      const task: GcalTask = { status: 'needsAction', ...(body as Partial<GcalTask>), id };
      store.set(id, { task, updatedAt: this.now });
      return reply(200, wire(store.get(id)!));
    }
    if (taskId !== undefined) {
      const existing = store.get(taskId);
      if (!existing || existing.task.deleted) {
        return reply(404, { error: { message: 'Not Found' } });
      }
      if (request.method === 'PATCH') {
        const patched: GcalTask = { ...existing.task, ...(body as Partial<GcalTask>), id: taskId };
        store.set(taskId, { task: patched, updatedAt: this.now });
        return reply(200, wire(store.get(taskId)!));
      }
      if (request.method === 'DELETE') {
        this.deleteTaskServerSide(listId, taskId);
        return reply(204);
      }
    }
    return reply(405);
  }

  // ---- helpers ----

  private bump(calendarId: string): number {
    const next = (this.versions.get(calendarId) ?? 0) + 1;
    this.versions.set(calendarId, next);
    return next;
  }

  private eventsOf(calendarId: string): Map<string, StoredEvent> {
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
