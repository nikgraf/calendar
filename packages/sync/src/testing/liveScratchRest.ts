/**
 * The live Google suites' admin side, as plain `fetch`: throwaway
 * calendars and task lists (which the app's clients deliberately cannot
 * create — the app holds `calendar.readonly` + `calendar.events`, not the
 * full `calendar` scope), the "other device" edits a test makes behind the
 * app's back, and the sweep that removes what a crashed run left behind.
 *
 * Effect-free and free of workspace imports on purpose: Node 24 runs this
 * file as-is (type stripping), so the iOS sidecar
 * (`scripts/google-live-scratch.ts`) shares it with the Effect wrapper in
 * `liveGoogle.ts` and the desktop e2e harness.
 */

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const TASKS_BASE = 'https://tasks.googleapis.com/tasks/v1';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

/** The full Calendar scope: `calendars.insert`/`delete` need it. */
export const LIVE_CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';

/** Every scratch resource is named `e2e-<unixSeconds>-<runTag>[-suffix]`. */
const SCRATCH_PREFIX = 'e2e-';

export interface LiveOAuth {
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
  readonly refreshToken: string;
}

export class LiveScratchError extends Error {
  readonly body: string;
  readonly status: number;
  constructor(status: number, body: string, url: string) {
    super(`Google answered ${status} for ${url}: ${body.slice(0, 400)}`);
    this.name = 'LiveScratchError';
    this.body = body;
    this.status = status;
  }
}

/** The event fields the suites read back; the wire carries more. */
export interface LiveEvent {
  readonly attendees?: ReadonlyArray<{
    readonly email?: string;
    readonly organizer?: boolean;
    readonly responseStatus?: string;
    readonly self?: boolean;
  }>;
  readonly description?: string;
  readonly end?: { readonly date?: string; readonly dateTime?: string; readonly timeZone?: string };
  readonly etag?: string;
  readonly extendedProperties?: { readonly private?: Record<string, string> };
  readonly id: string;
  readonly location?: string;
  readonly organizer?: { readonly email?: string; readonly self?: boolean };
  readonly recurrence?: ReadonlyArray<string>;
  readonly recurringEventId?: string;
  readonly reminders?: {
    readonly overrides?: ReadonlyArray<{ readonly method: string; readonly minutes: number }>;
    readonly useDefault: boolean;
  };
  readonly start?: {
    readonly date?: string;
    readonly dateTime?: string;
    readonly timeZone?: string;
  };
  readonly status?: string;
  readonly summary?: string;
}

export interface LiveTask {
  readonly completed?: string;
  readonly deleted?: boolean;
  readonly due?: string;
  readonly hidden?: boolean;
  readonly id: string;
  readonly notes?: string;
  readonly status?: string;
  readonly title?: string;
  readonly updated?: string;
}

export interface LiveCalendarListEntry {
  readonly accessRole?: string;
  readonly backgroundColor?: string;
  readonly deleted?: boolean;
  readonly id: string;
  readonly primary?: boolean;
  readonly summary?: string;
}

export interface LiveTaskList {
  readonly id: string;
  readonly title?: string;
}

export const scratchName = (runTag: string, suffix?: string): string =>
  `${SCRATCH_PREFIX}${Math.floor(Date.now() / 1000)}-${runTag}${suffix ? `-${suffix}` : ''}`;

export const parseScratchName = (
  name: string | undefined,
): { readonly createdAt: number; readonly runTag: string } | null => {
  const match = /^e2e-(\d+)-(.+)$/.exec(name ?? '');
  return match ? { createdAt: Number(match[1]) * 1000, runTag: match[2]! } : null;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Refresh-token grant → a one-hour access token (the app's TokenManager does the same). */
export const mintAccessToken = async (oauth: LiveOAuth): Promise<string> => {
  const form = new URLSearchParams({
    client_id: oauth.clientId,
    grant_type: 'refresh_token',
    refresh_token: oauth.refreshToken,
    ...(oauth.clientSecret ? { client_secret: oauth.clientSecret } : {}),
  });
  const response = await fetch(TOKEN_ENDPOINT, {
    body: form.toString(),
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    method: 'POST',
  });
  const text = await response.text();
  if (!response.ok) {
    throw new LiveScratchError(response.status, text, TOKEN_ENDPOINT);
  }
  const { access_token } = JSON.parse(text) as { access_token?: string };
  if (!access_token) {
    throw new LiveScratchError(response.status, text, TOKEN_ENDPOINT);
  }
  return access_token;
};

const isRateLimited = (error: unknown): boolean =>
  error instanceof LiveScratchError &&
  (error.status === 429 ||
    (error.status === 403 && /ateLimitExceeded|quotaExceeded|usageLimits/.test(error.body)));

const request = async <A>(
  token: string,
  method: 'DELETE' | 'GET' | 'PATCH' | 'POST',
  url: string,
  body?: unknown,
): Promise<A> => {
  const response = await fetch(url, {
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    method,
  });
  const text = await response.text();
  if (!response.ok) {
    throw new LiveScratchError(response.status, text, url);
  }
  return (text ? JSON.parse(text) : undefined) as A;
};

/** Google throttles secondary-calendar creation: back off a few times before giving up. */
const withRateLimitRetry = async <A>(run: () => Promise<A>): Promise<A> => {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (error) {
      if (attempt >= 5 || !isRateLimited(error)) {
        throw error;
      }
      await sleep(1000 * 2 ** attempt);
    }
  }
};

const calendarUrl = (calendarId: string, suffix = ''): string =>
  `${CALENDAR_BASE}/calendars/${encodeURIComponent(calendarId)}${suffix}`;
const eventUrl = (calendarId: string, eventId: string, query = ''): string =>
  calendarUrl(calendarId, `/events/${encodeURIComponent(eventId)}${query}`);
const listUrl = (listId: string, suffix = ''): string =>
  `${TASKS_BASE}/lists/${encodeURIComponent(listId)}${suffix}`;

// ---- calendars and task lists ----

export const createCalendar = (token: string, summary: string): Promise<{ readonly id: string }> =>
  withRateLimitRetry(() =>
    request<{ id: string }>(token, 'POST', `${CALENDAR_BASE}/calendars`, { summary }),
  );

/** calendars.delete — removes a secondary calendar outright (not just the subscription). */
export const deleteCalendar = (token: string, calendarId: string): Promise<void> =>
  request<void>(token, 'DELETE', calendarUrl(calendarId));

export const listCalendarList = async (
  token: string,
): Promise<ReadonlyArray<LiveCalendarListEntry>> => {
  const items: Array<LiveCalendarListEntry> = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${CALENDAR_BASE}/users/me/calendarList`);
    url.searchParams.set('maxResults', '250');
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }
    const page = await request<{
      items?: ReadonlyArray<LiveCalendarListEntry>;
      nextPageToken?: string;
    }>(token, 'GET', url.toString());
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
};

export const getCalendarListEntry = (
  token: string,
  calendarId: string,
): Promise<LiveCalendarListEntry> =>
  request(token, 'GET', `${CALENDAR_BASE}/users/me/calendarList/${encodeURIComponent(calendarId)}`);

export const createTaskList = (token: string, title: string): Promise<{ readonly id: string }> =>
  withRateLimitRetry(() =>
    request<{ id: string }>(token, 'POST', `${TASKS_BASE}/users/@me/lists`, { title }),
  );

export const deleteTaskList = (token: string, listId: string): Promise<void> =>
  request<void>(token, 'DELETE', `${TASKS_BASE}/users/@me/lists/${encodeURIComponent(listId)}`);

export const listTaskLists = async (token: string): Promise<ReadonlyArray<LiveTaskList>> => {
  const items: Array<LiveTaskList> = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(`${TASKS_BASE}/users/@me/lists`);
    url.searchParams.set('maxResults', '100');
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }
    const page = await request<{ items?: ReadonlyArray<LiveTaskList>; nextPageToken?: string }>(
      token,
      'GET',
      url.toString(),
    );
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
};

/**
 * Deletes every scratch calendar and task list older than `maxAgeMs` —
 * what a crashed or cancelled run left behind. Younger ones may belong to
 * a run still in flight (a local run overlapping CI), so they stay.
 * Per-item failures are swallowed: a sweep must never fail the suite.
 */
export const sweep = async (
  token: string,
  options: { readonly maxAgeMs: number; readonly now?: number },
): Promise<{ readonly calendars: number; readonly lists: number }> => {
  const cutoff = (options.now ?? Date.now()) - options.maxAgeMs;
  const stale = (name: string | undefined): boolean => {
    const parsed = parseScratchName(name);
    return parsed !== null && parsed.createdAt < cutoff;
  };
  let calendars = 0;
  for (const entry of await listCalendarList(token)) {
    if (!entry.primary && stale(entry.summary)) {
      try {
        await deleteCalendar(token, entry.id);
        calendars++;
      } catch {
        // Leave it for the next sweep.
      }
    }
  }
  let lists = 0;
  for (const list of await listTaskLists(token)) {
    if (stale(list.title)) {
      try {
        await deleteTaskList(token, list.id);
        lists++;
      } catch {
        // Leave it for the next sweep.
      }
      continue;
    }
    // A run's task that landed outside its scratch list (a UI flow whose
    // list pick missed) would otherwise stay forever: tasks titled
    // `live-…` in the account's own lists go once they are stale too.
    try {
      for (const task of await listTasks(token, list.id)) {
        const updated = Date.parse(task.updated ?? '');
        if (!task.deleted && task.title?.startsWith('live-') && updated < cutoff) {
          await deleteTask(token, list.id, task.id).catch(() => undefined);
        }
      }
    } catch {
      // Leave them for the next sweep.
    }
  }
  return { calendars, lists };
};

// ---- "the other device": raw event and task writes, never If-Match, never mail ----

export const getEvent = (token: string, calendarId: string, eventId: string): Promise<LiveEvent> =>
  request(token, 'GET', eventUrl(calendarId, eventId));

/** events.insert; forwards `id` when given (a client-generated id can be re-posted for a 409). */
export const insertEvent = (
  token: string,
  calendarId: string,
  event: Record<string, unknown>,
): Promise<LiveEvent> =>
  request(token, 'POST', calendarUrl(calendarId, '/events?sendUpdates=none'), event);

export const patchEvent = (
  token: string,
  calendarId: string,
  eventId: string,
  changes: Record<string, unknown>,
): Promise<LiveEvent> =>
  request(token, 'PATCH', eventUrl(calendarId, eventId, '?sendUpdates=none'), changes);

export const deleteEvent = (token: string, calendarId: string, eventId: string): Promise<void> =>
  request<void>(token, 'DELETE', eventUrl(calendarId, eventId, '?sendUpdates=none'));

/** events.list with a free-text `q` — how the UI suites find what they just saved. */
export const findEvents = async (
  token: string,
  calendarId: string,
  q: string,
): Promise<ReadonlyArray<LiveEvent>> => {
  const url = new URL(calendarUrl(calendarId, '/events'));
  url.searchParams.set('q', q);
  url.searchParams.set('showDeleted', 'true');
  url.searchParams.set('maxResults', '50');
  const page = await request<{ items?: ReadonlyArray<LiveEvent> }>(token, 'GET', url.toString());
  return page.items ?? [];
};

export const getTask = (token: string, listId: string, taskId: string): Promise<LiveTask> =>
  request(token, 'GET', listUrl(listId, `/tasks/${encodeURIComponent(taskId)}`));

export const insertTask = (
  token: string,
  listId: string,
  task: Record<string, unknown>,
): Promise<LiveTask> => request(token, 'POST', listUrl(listId, '/tasks'), task);

export const patchTask = (
  token: string,
  listId: string,
  taskId: string,
  changes: Record<string, unknown>,
): Promise<LiveTask> =>
  request(token, 'PATCH', listUrl(listId, `/tasks/${encodeURIComponent(taskId)}`), changes);

export const deleteTask = (token: string, listId: string, taskId: string): Promise<void> =>
  request<void>(token, 'DELETE', listUrl(listId, `/tasks/${encodeURIComponent(taskId)}`));

/** Every task in the list, deleted and hidden ones included. */
export const listTasks = async (
  token: string,
  listId: string,
): Promise<ReadonlyArray<LiveTask>> => {
  const items: Array<LiveTask> = [];
  let pageToken: string | undefined;
  do {
    const url = new URL(listUrl(listId, '/tasks'));
    url.searchParams.set('maxResults', '100');
    url.searchParams.set('showCompleted', 'true');
    url.searchParams.set('showDeleted', 'true');
    url.searchParams.set('showHidden', 'true');
    if (pageToken) {
      url.searchParams.set('pageToken', pageToken);
    }
    const page = await request<{ items?: ReadonlyArray<LiveTask>; nextPageToken?: string }>(
      token,
      'GET',
      url.toString(),
    );
    items.push(...(page.items ?? []));
    pageToken = page.nextPageToken;
  } while (pageToken);
  return items;
};
