import {
  LIVE_ACCOUNT_ID,
  type LiveGoogleConfig,
  liveGoogleConfigFromEnv,
  LiveScratch,
  type LiveScratchShape,
  makeScratchRuntime,
  scratchName,
} from '@calendar/sync/testing/liveGoogle';
import { LiveScratchError } from '@calendar/sync/testing/liveScratchRest';
import { Effect, type ManagedRuntime } from 'effect';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vite-plus/test';
import {
  type App,
  launchApp,
  readAccounts,
  readCalendars,
  readEvents,
  readPendingOpsCount,
  readTasks,
} from './harness.ts';
import type { PageKit } from './page.ts';

/**
 * The desktop app signed in as the live test account, against Google
 * itself: what the user does in the UI lands on Google, what another
 * device does on Google shows up here, and a 412 is settled from the
 * banner. Opt-in (`CALENDAR_E2E_GOOGLE=live`) — it needs the live token
 * (docs/google-sync-and-testing.md) and writes to the account. Its
 * calendar and task list are created for this run and deleted after;
 * every title carries the run tag.
 */

const LIVE = process.env['CALENDAR_E2E_GOOGLE'] === 'live';
const POLL = { timeout: 45_000 };
const HOUR_MS = 60 * 60 * 1000;
const HOUR_HEIGHT = 48;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// No retry: E2E=1 gives the fixture specs one, and a retried create would
// write a second event with the same title. Two minutes per test: the
// polls below wait on Google, not on a local fake.
/** The conflict banner's text contains `text` (a page function). */
const bannerShows = ($: PageKit, text: string) =>
  $.text('[data-testid="conflict-banner"]').includes(text);

describe.skipIf(!LIVE)('Google live (real account)', { retry: 0, timeout: 120_000 }, () => {
  let config: LiveGoogleConfig;
  let runtime: ManagedRuntime.ManagedRuntime<LiveScratch, never>;
  let app: App;
  let calendarId = '';
  let calendarName = '';
  let listId = '';
  let listName = '';
  const tag = () => `live-${config.runTag}`;

  const google = <A, E>(use: (scratch: LiveScratchShape) => Effect.Effect<A, E>): Promise<A> =>
    runtime.runPromise(Effect.flatMap(LiveScratch, use));

  /** `events.get` as a status string: `confirmed`/`cancelled`, or `http 404`/`410`. */
  const serverStatus = (eventId: string): Promise<string> =>
    google((scratch) =>
      scratch.getEvent(calendarId, eventId).pipe(
        Effect.map((event) => event.status ?? 'confirmed'),
        Effect.catchTag('LiveGoogleError', (error) =>
          Effect.succeed(
            `http ${error.cause instanceof LiveScratchError ? error.cause.status : '?'}`,
          ),
        ),
        Effect.catchTag('ReauthRequiredError', () => Effect.succeed('reauth')),
        Effect.catchTag('TokenRefreshError', () => Effect.succeed('reauth')),
      ),
    );

  const eventByTitle = async (title: string) =>
    (await readEvents(app.userDataDir)).find((event) => event.title === title);

  /** Sets a React-controlled input/select through the prototype setter. */
  const setControl = (selector: string, value: string) =>
    app.cdp.evaluate(
      ($, control: string, next: string) => $.setValue(control, next),
      selector,
      value,
    );
  const setEditorTitle = (title: string) => setControl('input[placeholder="Title"]', title);
  /** The editor's calendar (or task list) select: the run's own, never the account's first. */
  const pickRunCalendar = () =>
    setControl('select[aria-label="Calendar"]', `${LIVE_ACCOUNT_ID}:${calendarId}`);
  const pickRunList = () =>
    setControl('select[aria-label="Task list"]', `${LIVE_ACCOUNT_ID}:${listId}`);

  /**
   * A point on today's column at a wall-clock hour with nothing on it (the
   * run calendar is empty by construction): 16:00 in the morning, 04:00
   * from noon on. The now line is never under the click or the later
   * one-hour drag, and both stay inside the day, clear of the DST hours.
   */
  const freeSlot = async (): Promise<{ x: number; y: number }> => {
    const hour = new Date().getHours() < 12 ? 16 : 4;
    const label = new Date().toLocaleDateString('en-US', {
      day: 'numeric',
      month: 'long',
      weekday: 'long',
    });
    return app.cdp.evaluate(
      ($, prefix: string, minutes: number, hourHeight: number) => {
        const column = $.all('[role="button"][aria-label]').find((element) =>
          element.getAttribute('aria-label')!.startsWith(prefix),
        )!;
        const scroller = column.closest('.overflow-y-scroll')!;
        const offset = (minutes / 60) * hourHeight;
        scroller.scrollTop = offset - scroller.clientHeight / 2;
        const rect = column.getBoundingClientRect();
        return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + offset) };
      },
      `${label}:`,
      hour * 60 + 5,
      HOUR_HEIGHT,
    );
  };

  const openNewEventAt = async (): Promise<void> => {
    const at = await freeSlot();
    await app.cdp.click(at.x, at.y);
    await app.cdp.waitUntil(() => document.body.textContent.includes('New event'));
  };

  /** The event this file drives through create → edit → drag → conflicts → delete. */
  let title = '';

  beforeAll(async () => {
    config = liveGoogleConfigFromEnv();
    runtime = makeScratchRuntime(config);
    calendarName = scratchName(config, 'desktop');
    listName = scratchName(config, 'desktop-tasks');
    await google((scratch) =>
      Effect.gen(function* () {
        // Before anything is created: a token for another account stops the run here.
        yield* scratch.sweep({ email: config.email, maxAgeMs: 6 * HOUR_MS });
        calendarId = (yield* scratch.createCalendar(calendarName)).id;
        listId = (yield* scratch.createTaskList(listName)).id;
      }),
    );
    app = await launchApp(undefined, {
      google: {
        live: {
          clientId: config.clientId,
          clientSecret: config.clientSecret,
          contactsEnabled: false,
          email: config.email,
          refreshToken: config.refreshToken,
          syncIntervalMs: 10_000,
          tasksEnabled: true,
        },
      },
    });
    title = `${tag()}-desktop`;
  }, 120_000);

  // Screenshot, DOM and the app's own log for whatever failed; CI uploads
  // e2e-artifacts/ after redacting it.
  afterEach(async (context) => {
    if (context.task.result?.state === 'fail') {
      await app?.dump(context.task.name);
    }
  });

  afterAll(async () => {
    await app?.stop();
    if (runtime) {
      await google((scratch) =>
        Effect.gen(function* () {
          if (calendarId) {
            yield* Effect.ignore(scratch.deleteCalendar(calendarId));
          }
          if (listId) {
            yield* Effect.ignore(scratch.deleteTaskList(listId));
          }
        }),
      );
      await runtime.dispose();
    }
  }, 60_000);

  it('signs in with the live token and pulls the run calendar', async () => {
    await expect
      .poll(
        async () => (await readCalendars(app.userDataDir)).some((c) => c.id === calendarId),
        POLL,
      )
      .toBe(true);
    // A dead refresh token flips the row to reauth_required on the first pass.
    const account = (await readAccounts(app.userDataDir)).find((a) => a.id === LIVE_ACCOUNT_ID);
    expect(account?.status, 'the refresh token still works').toBe('ok');
    await app.cdp.waitUntil(
      (_, want: string) => document.body.textContent.includes(want),
      calendarName,
    );
  });

  it('creates an event in the run calendar; it lands on Google with an etag', async () => {
    await openNewEventAt();
    await setEditorTitle(title);
    await pickRunCalendar();
    await app.cdp.clickButtonWithText('Save');
    await app.cdp.waitUntil(
      ($, shown: string) => $.has(`[title^=${JSON.stringify(shown)}]`),
      title,
    );
    const row = await expect
      .poll(async () => {
        const event = await eventByTitle(title);
        return event?.syncStatus === 'synced' && event.etag ? event : undefined;
      }, POLL)
      .toBeDefined()
      .then(() => eventByTitle(title));
    expect(row?.calendarId).toBe(calendarId);
    const server = await google((scratch) => scratch.getEvent(calendarId, row!.id));
    expect(server.summary).toBe(title);
    expect(server.etag).toBe(row?.etag);
  });

  it('edits the title through the editor; Google follows', async () => {
    await app.cdp.openEditor(`[title^=${JSON.stringify(title)}]`);
    const edited = `${title} edited`;
    await setEditorTitle(edited);
    await app.cdp.clickButtonWithText('Save');
    await app.cdp.waitUntil(
      ($, shown: string) => $.has(`[title^=${JSON.stringify(shown)}]`),
      edited,
    );
    const row = (await eventByTitle(edited))!;
    await expect
      .poll(
        () => google((scratch) => scratch.getEvent(calendarId, row.id)).then((e) => e.summary),
        POLL,
      )
      .toBe(edited);
    await expect.poll(() => readPendingOpsCount(app.userDataDir), POLL).toBe(0);
    title = edited;
  });

  it('drags the block an hour later; Google’s start moves with it', async () => {
    const before = (await eventByTitle(title))!;
    const from = await app.cdp.locate(`[title^=${JSON.stringify(title)}]`);
    await app.cdp.drag(from, { x: from.x, y: from.y + HOUR_HEIGHT });
    await expect
      .poll(async () => (await eventByTitle(title))?.startUtc, POLL)
      .toBe(before.startUtc + HOUR_MS);
    await expect
      .poll(
        () =>
          google((scratch) => scratch.getEvent(calendarId, before.id)).then((e) =>
            Date.parse(e.start?.dateTime ?? ''),
          ),
        POLL,
      )
      .toBe(before.startUtc + HOUR_MS);
    await expect.poll(() => readPendingOpsCount(app.userDataDir), POLL).toBe(0);
  });

  /**
   * One 412 round: the sheet is filled first and Google patched right
   * before Save, so the app's own 10 s poll rarely gets to refresh the
   * etag in between (that would let the edit land and show no banner).
   * When a poll still wins, the round repeats with the same titles — the
   * block is located by the title prefix every title here shares.
   */
  const conflictingEdit = async (suffix: string): Promise<{ mine: string; theirs: string }> => {
    const row = (await eventByTitle(title))!;
    const theirs = `${title} google-${suffix}`;
    const mine = `${title} mine-${suffix}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      await app.cdp.openEditor(`[title^=${JSON.stringify(title)}]`);
      await setEditorTitle(mine);
      // Another device renames it now; the Save carries the stale etag.
      await google((scratch) => scratch.patchEvent(calendarId, row.id, { summary: theirs }));
      await app.cdp.clickButtonWithText('Save');
      const parked = await app.cdp
        .waitUntil({ timeoutMs: 15_000 }, bannerShows, mine)
        .then(() => true)
        .catch(() => false);
      if (parked) {
        return { mine, theirs };
      }
      // The poll defused it: the edit landed as `mine`, so re-sync to
      // Google's view before the next attempt.
      await expect.poll(() => readPendingOpsCount(app.userDataDir), POLL).toBe(0);
    }
    throw new Error(`no conflict banner after three rounds for ${title}`);
  };

  it('a rename behind the app’s back parks the edit; Take theirs loads Google’s copy', async () => {
    const { theirs } = await conflictingEdit('1');
    await app.cdp.clickButtonWithText('Take theirs');
    await expect
      .poll(async () => {
        const row = await eventByTitle(theirs);
        return row?.syncStatus;
      }, POLL)
      .toBe('synced');
    await expect.poll(() => readPendingOpsCount(app.userDataDir), POLL).toBe(0);
    await app.cdp.waitUntil(($) => !$.has('[data-testid="conflict-banner"]'));
    title = theirs;
  });

  it('Keep mine re-sends the edit without If-Match and Google takes it', async () => {
    const before = (await eventByTitle(title))!;
    const { mine } = await conflictingEdit('2');
    await app.cdp.clickButtonWithText('Keep mine');
    await expect
      .poll(
        () => google((scratch) => scratch.getEvent(calendarId, before.id)).then((e) => e.summary),
        POLL,
      )
      .toBe(mine);
    await expect.poll(() => readPendingOpsCount(app.userDataDir), POLL).toBe(0);
    await app.cdp.waitUntil(($) => !$.has('[data-testid="conflict-banner"]'));
    title = mine;
  });

  it('deletes through the editor; Google answers cancelled', async () => {
    const row = (await eventByTitle(title))!;
    await app.cdp.openEditor(`[title^=${JSON.stringify(title)}]`);
    await app.cdp.clickButtonWithText('Delete');
    await app.cdp.confirmDelete();
    await app.cdp.waitUntil(($, gone: string) => !$.has(`[title^=${JSON.stringify(gone)}]`), title);
    await expect
      .poll(() => serverStatus(row.id), POLL)
      .toSatisfy((status: string) => ['cancelled', 'http 404', 'http 410'].includes(status));
    await expect.poll(() => readPendingOpsCount(app.userDataDir), POLL).toBe(0);
  });

  it('creates a task in the run list and checks it off; Google completes it', async () => {
    const taskTitle = `${tag()}-task`;
    await openNewEventAt();
    await app.cdp.clickButtonWithText('Task');
    await app.cdp.waitUntil(() => document.body.textContent.includes('New task'));
    await setEditorTitle(taskTitle);
    await pickRunList();
    await app.cdp.clickButtonWithText('Save');
    await app.cdp.waitUntil(
      ($, shown: string) => $.has(`[title=${JSON.stringify(shown)}]`),
      taskTitle,
    );
    // The temp id becomes Google's once the create lands.
    const task = await expect
      .poll(async () => {
        const row = (await readTasks(app.userDataDir)).find((t) => t.title === taskTitle);
        return row && !row.id.startsWith('local-') ? row : undefined;
      }, POLL)
      .toBeDefined()
      .then(async () => (await readTasks(app.userDataDir)).find((t) => t.title === taskTitle)!);
    expect(task.listId).toBe(listId);
    expect((await google((scratch) => scratch.getTask(listId, task.id))).title).toBe(taskTitle);

    const checkbox = await app.cdp.locate(`[title=${JSON.stringify(taskTitle)}] button`);
    await app.cdp.click(checkbox.x, checkbox.y);
    await app.cdp.waitUntil(
      ($, task: string) => $.has(`[title=${JSON.stringify(task)}] [data-done]`),
      taskTitle,
    );
    await expect
      .poll(() => google((scratch) => scratch.getTask(listId, task.id)).then((t) => t.status), POLL)
      .toBe('completed');
    await expect.poll(() => readPendingOpsCount(app.userDataDir), POLL).toBe(0);
  });

  it('what another device adds shows up through the poll', { timeout: 180_000 }, async () => {
    const pulled = `${tag()}-pulled`;
    const start = Math.ceil(Date.now() / HOUR_MS) * HOUR_MS + 3 * HOUR_MS;
    await google((scratch) =>
      scratch.insertEvent(calendarId, {
        end: { dateTime: new Date(start + HOUR_MS).toISOString() },
        start: { dateTime: new Date(start).toISOString() },
        summary: pulled,
      }),
    );
    // The poll runs every 10 s in this launch; two ticks is plenty.
    await expect
      .poll(async () => (await eventByTitle(pulled))?.syncStatus, { timeout: 40_000 })
      .toBe('synced');
    await app.cdp.waitUntil(
      ($, shown: string) => $.has(`[title^=${JSON.stringify(shown)}]`),
      pulled,
    );

    // And a server-side un-complete of the task reaches the chip.
    const taskTitle = `${tag()}-task`;
    const task = (await readTasks(app.userDataDir)).find((t) => t.title === taskTitle)!;
    await google((scratch) =>
      scratch.patchTask(listId, task.id, { completed: null, status: 'needsAction' }),
    );
    await sleep(500);
    await expect
      .poll(async () => (await readTasks(app.userDataDir)).find((t) => t.id === task.id)?.status, {
        timeout: 60_000,
      })
      .toBe('needsAction');
  });
});
