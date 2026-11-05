import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  checkedRunTag,
  isLiveTitle,
  parseScratchName,
  scratchName,
  sweep,
} from './liveScratchRest.ts';

const HOUR = 3_600_000;
const NOW = 1_800_000_000_000;
const MAX_AGE = 6 * HOUR;
/** Unix seconds `hours` before `NOW`, as a scratch name carries them. */
const secondsAgo = (hours: number): number => (NOW - hours * HOUR) / 1000;
const iso = (hours: number): string => new Date(NOW - hours * HOUR).toISOString();

interface FakeAccount {
  readonly calendars: ReadonlyArray<{ id: string; primary?: boolean; summary: string }>;
  /** What userinfo answers; `undefined` leaves the address out. */
  readonly email: string | undefined;
  readonly lists: ReadonlyArray<{
    id: string;
    tasks?: ReadonlyArray<{ id: string; title: string; updated: string }>;
    title: string;
  }>;
}

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

/**
 * Google as the sweep sees it: answers its reads and records every
 * request. `userinfoFailures` are what the first account reads get
 * instead: a status, or no answer at all.
 */
const fakeGoogle = (
  account: FakeAccount,
  userinfoFailures: ReadonlyArray<number | 'no answer'> = [],
) => {
  const requests: Array<string> = [];
  const failures = [...userinfoFailures];
  vi.stubGlobal('fetch', (input: string | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    requests.push(`${method} ${url.host}${url.pathname}`);
    if (method === 'DELETE') {
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url.pathname.endsWith('/userinfo')) {
      const failure = failures.shift();
      if (failure === 'no answer') {
        return Promise.reject(new TypeError('fetch failed'));
      }
      if (failure !== undefined) {
        return Promise.resolve(new Response('{}', { status: failure }));
      }
      return Promise.resolve(json(account.email === undefined ? {} : { email: account.email }));
    }
    if (url.pathname.endsWith('/users/me/calendarList')) {
      return Promise.resolve(json({ items: account.calendars }));
    }
    if (url.pathname.endsWith('/users/@me/lists')) {
      return Promise.resolve(
        json({ items: account.lists.map(({ id, title }) => ({ id, title })) }),
      );
    }
    const tasksOf = /\/lists\/([^/]+)\/tasks$/.exec(url.pathname);
    if (tasksOf) {
      const list = account.lists.find((candidate) => candidate.id === tasksOf[1]);
      return Promise.resolve(json({ items: list?.tasks ?? [] }));
    }
    return Promise.resolve(new Response('{}', { status: 404 }));
  });
  return {
    deleted: () =>
      requests
        .filter((line) => line.startsWith('DELETE '))
        .map((line) => line.slice(line.lastIndexOf('/') + 1)),
    requests,
  };
};

const LIVE = 'live-account@example.com';

/** Stale leftovers of two runs next to everything a sweep must leave alone. */
const account: FakeAccount = {
  calendars: [
    { id: 'stale-ci', summary: `e2e-${secondsAgo(7)}-gh-501-1-node` },
    { id: 'stale-local', summary: `e2e-${secondsAgo(30)}-local-4242-desktop` },
    { id: 'in-flight', summary: `e2e-${secondsAgo(1)}-gh-502-1-node` },
    // Names a person could have given a calendar: `e2e-` alone proves nothing.
    { id: 'someones-notes', summary: 'e2e-2024-notes' },
    { id: 'someones-plan', summary: `e2e-${secondsAgo(30)}-nightly` },
    { id: 'someones-tag', summary: `e2e-${secondsAgo(30)}-gh-501-1 Review` },
    { id: 'the-primary', primary: true, summary: `e2e-${secondsAgo(30)}-gh-500-1` },
  ],
  email: LIVE,
  lists: [
    { id: 'stale-list', title: `e2e-${secondsAgo(7)}-gh-501-1-node-tasks-2` },
    { id: 'in-flight-list', title: `e2e-${secondsAgo(1)}-local-77-ios-tasks` },
    {
      id: 'my-tasks',
      tasks: [
        { id: 'stale-task', title: 'live-gh-501-1-ios-task', updated: iso(7) },
        { id: 'in-flight-task', title: 'live-local-77-ios-task', updated: iso(1) },
        // Titles a person could have written: `live-` alone proves nothing.
        { id: 'someones-task', title: 'live-stream prep', updated: iso(30) },
        { id: 'someones-other', title: 'live-gh-pages deploy', updated: iso(30) },
      ],
      title: 'My Tasks',
    },
  ],
};

describe('live scratch sweep', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('a token for another account is refused before anything is listed', async () => {
    const google = fakeGoogle({ ...account, email: 'someone-else@example.com' });
    await expect(sweep('token', { email: LIVE, maxAgeMs: MAX_AGE, now: NOW })).rejects.toThrow(
      /does not sign in as GOOGLE_LIVE_EMAIL: nothing was deleted/,
    );
    expect(google.requests).toEqual(['GET openidconnect.googleapis.com/v1/userinfo']);
  });

  it('the refusal names neither address', async () => {
    fakeGoogle({ ...account, email: 'someone-else@example.com' });
    const refusal: unknown = await sweep('token', {
      email: LIVE,
      maxAgeMs: MAX_AGE,
      now: NOW,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(refusal).toBeInstanceOf(Error);
    expect(String(refusal)).not.toContain('@example.com');
  });

  it('a token Google names no address for is refused too', async () => {
    const google = fakeGoogle({ ...account, email: undefined });
    await expect(sweep('token', { email: LIVE, maxAgeMs: MAX_AGE, now: NOW })).rejects.toThrow(
      /names no address/,
    );
    expect(google.deleted()).toEqual([]);
  });

  it('an account read Google did not answer is tried again; one it refused is not', async () => {
    vi.useFakeTimers();
    try {
      const google = fakeGoogle({ ...account, calendars: [], lists: [] }, [503, 'no answer']);
      const swept = sweep('token', { email: LIVE, maxAgeMs: MAX_AGE, now: NOW });
      await vi.runAllTimersAsync();
      expect(await swept).toEqual({ calendars: 0, lists: 0 });
      expect(google.requests.filter((line) => line.endsWith('/userinfo'))).toHaveLength(3);

      const refused = fakeGoogle(account, [401]);
      const failed = sweep('token', { email: LIVE, maxAgeMs: MAX_AGE, now: NOW }).then(
        () => undefined,
        (error: unknown) => error,
      );
      await vi.runAllTimersAsync();
      expect(String(await failed)).toContain('Google answered 401');
      expect(refused.requests).toEqual(['GET openidconnect.googleapis.com/v1/userinfo']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('the live account loses only what a run named and left behind', async () => {
    // Google spells the address its own way: case and padding are not a mismatch.
    const google = fakeGoogle({ ...account, email: 'Live-Account@Example.com' });
    const swept = await sweep('token', { email: ` ${LIVE}`, maxAgeMs: MAX_AGE, now: NOW });
    expect(swept).toEqual({ calendars: 2, lists: 1 });
    expect(google.deleted()).toEqual(['stale-ci', 'stale-local', 'stale-list', 'stale-task']);
  });
});

describe('live scratch names', () => {
  it('reads back what a run names, on CI and locally, with every suffix in use', () => {
    const suffixes = [
      undefined,
      'node',
      'node-2',
      'node-tasks',
      'node-tasks-2',
      'list',
      'desktop',
      'desktop-tasks',
      'ios',
      'ios-tasks',
    ];
    for (const runTag of ['gh-18273645-2', 'local-4242']) {
      for (const suffix of suffixes) {
        const parsed = parseScratchName(scratchName(runTag, suffix));
        expect(parsed?.runTag, `${runTag} ${suffix}`).toBe(runTag);
        expect(Date.now() - (parsed?.createdAt ?? 0)).toBeLessThan(5000);
      }
    }
  });

  it('reads nothing a run did not name', () => {
    const seconds = secondsAgo(30);
    for (const name of [
      undefined,
      '',
      'e2e-2024-notes',
      'e2e-1-run-ios',
      `e2e-${seconds}-nightly`,
      // Unix seconds have ten digits: fewer or more is not a run's stamp.
      'e2e-12345-gh-501-1-node',
      `e2e-${seconds}0-gh-501-1-node`,
      `e2e-${seconds}-gh-501`,
      `e2e-${seconds}-local-`,
      `e2e-${seconds}-gh-501-1 Review`,
      `e2e-${seconds}-gh-501-1-Node`,
      `E2E-${seconds}-gh-501-1`,
      ` e2e-${seconds}-gh-501-1`,
      `e2e-${seconds}-gh-501-1\nextra`,
    ]) {
      expect(parseScratchName(name), String(name)).toBeNull();
    }
  });

  it('refuses to name a run the sweep would not know again', () => {
    for (const runTag of ['', 'debug', 'gh-501', 'local-', 'local-12ab', 'gh-501-1-extra']) {
      expect(() => checkedRunTag(runTag), runTag).toThrow(/GOOGLE_LIVE_RUN_TAG/);
      expect(() => scratchName(runTag), runTag).toThrow(/GOOGLE_LIVE_RUN_TAG/);
    }
    for (const suffix of ['iOS', 'ios tasks', 'ios_tasks', 'ios-', '-ios']) {
      expect(() => scratchName('local-4242', suffix), suffix).toThrow(/scratch suffix/);
    }
  });

  it('knows a run’s titles by the tag after `live-`', () => {
    expect(isLiveTitle('live-gh-501-1-invite')).toBe(true);
    expect(isLiveTitle('live-local-4242-ios-task')).toBe(true);
    for (const title of [
      undefined,
      'live-',
      'live-stream prep',
      'live-gh-pages deploy',
      'live-local-news',
      'live-gh-501-1',
      'Complete live-gh-501-1-ios-task',
    ]) {
      expect(isLiveTitle(title), String(title)).toBe(false);
    }
  });
});
