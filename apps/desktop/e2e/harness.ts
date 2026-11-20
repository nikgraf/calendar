import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Account,
  CalendarInfo,
  EventRecord,
  GoogleBirthday,
  GoogleContact,
  type PendingOp,
  TaskListInfo,
  TaskRecord,
} from '@calendar/core';
import {
  type AgentPolicy,
  AgentRepo,
  AgentRequestRepo,
  type AgentRequestRecord,
  agentStoreLayer,
  hashToken,
} from '@calendar/agent';
import type { TranscriptSegment } from '@calendar/ai';
import type { AppleCalendarJson, FakeEventSeed } from '@calendar/apple-calendar';
import type { DeviceBirthdayJson, DeviceContactJson } from '@calendar/contacts';
import type { FakePlace } from '@calendar/geo';
import type { ReminderJson, ReminderListJson } from '@calendar/reminders';
import type { GoogleFixture } from '@calendar/sync/testing/googleFixture';
import type { LiveAccountSeed } from '@calendar/sync/testing/liveGoogle';
import {
  AccountRepo,
  BirthdayRepo,
  CalendarRepo,
  ContactRepo,
  DeviceSettingsRepo,
  EventRepo,
  PendingOpRepo,
  reposLayer,
  runMigrations,
  TaskRepo,
} from '@calendar/db';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/reactivity/Reactivity';
import { SqlClient } from 'effect/sql/SqlClient';
import {
  type PageArgs,
  pageExpression,
  type PageFunction,
  type PageKit,
  pageSource,
  type PageValue,
} from './page.ts';

const require = createRequire(import.meta.url);

/* eslint-disable no-console -- harness diagnostics are wanted in e2e output */

/**
 * For a cleanup loop that leaves an editor by its Cancel, in one call:
 * Discard Changes while the editor asks (`DiscardConfirm`), else Cancel.
 */
export const cancelOrDiscard = ($: PageKit): void => {
  const yes = $.el('[data-testid="discard-confirm-yes"]');
  if (yes) {
    yes.click();
    return;
  }
  $.button('Cancel')?.click();
};

/**
 * The *local* ISO date `days` before today (negative = ahead), for
 * date-only seeds: the app places a task on the day in the machine's zone,
 * and between local midnight and UTC midnight the UTC date is still
 * yesterday (CI runs in UTC; dev does not).
 */
export const localIsoDaysAgo = (days: number): string => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return localIsoOf(date.getTime());
};

/** The *local* ISO date of an instant: the day column the app draws it in. */
export const localIsoOf = (epochMs: number): string => {
  const date = new Date(epochMs);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
};

/**
 * The local wall-clock time `hour:minute` on the day `days` from today
 * (negative = back), as epoch ms: for timed seeds the app must draw on
 * that day, whose columns are the machine's local days. Seeds at an hour
 * of the *UTC* date sat a day off whenever that hour, read locally, fell
 * on another date (in the hour after local midnight in CET, two in CEST;
 * most hours in UTC+12); CI runs in UTC, where both are the same.
 */
export const localDayAt = (days: number, hour: number, minute = 0): number => {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, minute).getTime();
};

// ---------------------------------------------------------------------------
// Seeding: build the schema with the app's own migrations, insert fixtures.
// Must run BEFORE the app launches (external writes don't invalidate atoms).
// ---------------------------------------------------------------------------

export interface SeedData {
  readonly accounts: ReadonlyArray<Account>;
  /** Google People birthday rows (the device half comes from a contacts fixture). */
  readonly birthdays?: ReadonlyArray<GoogleBirthday>;
  readonly calendars: ReadonlyArray<CalendarInfo>;
  /** Google People cache rows — the typeahead's only source with CALENDAR_CONTACTS=off. */
  readonly contacts?: ReadonlyArray<GoogleContact>;
  /** device_settings rows (JSON values by key), as the app would have stored them. */
  readonly deviceSettings?: Readonly<Record<string, unknown>>;
  readonly events: ReadonlyArray<EventRecord>;
  /** Queued changes as the app would have left them (e.g. a parked 412). */
  readonly pendingOps?: ReadonlyArray<PendingOp>;
  readonly taskLists?: ReadonlyArray<TaskListInfo>;
  readonly tasks?: ReadonlyArray<TaskRecord>;
}

export const seedDatabase = async (userDataDir: string, seed: SeedData): Promise<void> => {
  const dbLayer = reposLayer.pipe(
    Layer.provideMerge(Layer.effectDiscard(runMigrations)),
    Layer.provideMerge(SqliteClient.layer({ filename: join(userDataDir, 'calendar.db') })),
    Layer.provideMerge(reactivityLayer),
  );
  await Effect.runPromise(
    Effect.gen(function* () {
      const accounts = yield* AccountRepo;
      const calendars = yield* CalendarRepo;
      const events = yield* EventRepo;
      for (const account of seed.accounts) {
        yield* accounts.upsert(account);
      }
      yield* calendars.upsertMany(seed.calendars);
      yield* events.upsertMany(seed.events);
      for (const op of seed.pendingOps ?? []) {
        yield* (yield* PendingOpRepo).enqueue(op);
      }
      const tasks = yield* TaskRepo;
      yield* tasks.upsertLists(seed.taskLists ?? [], 1);
      yield* tasks.upsertTasks(seed.tasks ?? [], 1);
      yield* (yield* ContactRepo).upsertMany(seed.contacts ?? [], 1);
      yield* (yield* BirthdayRepo).upsertMany(seed.birthdays ?? [], 1);
      const deviceSettings = yield* DeviceSettingsRepo;
      for (const [key, value] of Object.entries(seed.deviceSettings ?? {})) {
        yield* deviceSettings.set(key, value);
      }
    }).pipe(Effect.provide(dbLayer)),
  );
};

/** One device_settings row as the app stored it (JSON), or null. */
export const readDeviceSetting = async (userDataDir: string, key: string): Promise<unknown> => {
  const dbLayer = reposLayer.pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: join(userDataDir, 'calendar.db') })),
    Layer.provideMerge(reactivityLayer),
  );
  return Effect.runPromise(
    Effect.flatMap(DeviceSettingsRepo, (repo) => repo.get(key)).pipe(Effect.provide(dbLayer)),
  );
};

export const readSettings = (userDataDir: string): Record<string, unknown> => {
  try {
    return JSON.parse(readFileSync(join(userDataDir, 'settings.json'), 'utf8')) as Record<
      string,
      unknown
    >;
  } catch {
    return {};
  }
};

export const readCalendars = async (userDataDir: string): Promise<ReadonlyArray<CalendarInfo>> => {
  const dbLayer = reposLayer.pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: join(userDataDir, 'calendar.db') })),
    Layer.provideMerge(reactivityLayer),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* CalendarRepo).list();
    }).pipe(Effect.provide(dbLayer)),
  );
};

export const readPendingOps = async (userDataDir: string) => {
  const dbLayer = reposLayer.pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: join(userDataDir, 'calendar.db') })),
    Layer.provideMerge(reactivityLayer),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* PendingOpRepo).listAll();
    }).pipe(Effect.provide(dbLayer)),
  );
};

export const readLocationGeoCount = async (userDataDir: string): Promise<number> => {
  const dbLayer = SqliteClient.layer({ filename: join(userDataDir, 'calendar.db') });
  return Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient;
      const rows = yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM location_geo`;
      return rows[0]?.n ?? 0;
    }).pipe(Effect.provide(dbLayer)),
  );
};

export const readPendingOpsCount = async (userDataDir: string): Promise<number> => {
  const dbLayer = reposLayer.pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: join(userDataDir, 'calendar.db') })),
    Layer.provideMerge(reactivityLayer),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const ops = yield* (yield* PendingOpRepo).listAll();
      return ops.length;
    }).pipe(Effect.provide(dbLayer)),
  );
};

export const readAccounts = async (userDataDir: string): Promise<ReadonlyArray<Account>> => {
  const dbLayer = reposLayer.pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: join(userDataDir, 'calendar.db') })),
    Layer.provideMerge(reactivityLayer),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* AccountRepo).list();
    }).pipe(Effect.provide(dbLayer)),
  );
};

export const readTaskLists = async (userDataDir: string): Promise<ReadonlyArray<TaskListInfo>> => {
  const dbLayer = reposLayer.pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: join(userDataDir, 'calendar.db') })),
    Layer.provideMerge(reactivityLayer),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* TaskRepo).listLists();
    }).pipe(Effect.provide(dbLayer)),
  );
};

export const readTasks = async (userDataDir: string): Promise<ReadonlyArray<TaskRecord>> => {
  const dbLayer = reposLayer.pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: join(userDataDir, 'calendar.db') })),
    Layer.provideMerge(reactivityLayer),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const tasks = yield* TaskRepo;
      // Every dated task, plus the open ones without a due day.
      return [
        ...(yield* tasks.getWindow('0000-01-01', '9999-12-31')),
        ...(yield* tasks.getUndatedOpen()),
      ];
    }).pipe(Effect.provide(dbLayer)),
  );
};

/** A calendar mirror's copies in a calendar: hidden from `readEvents` like from the views. */
export const readMirrorCopies = async (
  userDataDir: string,
  accountId: string,
  calendarId: string,
): Promise<ReadonlyArray<EventRecord>> => {
  const dbLayer = reposLayer.pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: join(userDataDir, 'calendar.db') })),
    Layer.provideMerge(reactivityLayer),
  );
  return Effect.runPromise(
    Effect.flatMap(EventRepo, (events) =>
      events.listMirrorCopies(accountId, calendarId, 0, Number.MAX_SAFE_INTEGER),
    ).pipe(Effect.provide(dbLayer)),
  );
};

export const readEvents = async (userDataDir: string): Promise<ReadonlyArray<EventRecord>> => {
  const dbLayer = reposLayer.pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: join(userDataDir, 'calendar.db') })),
    Layer.provideMerge(reactivityLayer),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const events = yield* EventRepo;
      const window = yield* events.getWindow(0, 8_640_000_000_000);
      return [...window.singles, ...window.masters];
    }).pipe(Effect.provide(dbLayer)),
  );
};

/**
 * The stored rows a range is drawn from, as the views read them: masters,
 * their exceptions (cancelled ones included, in any range) and singles.
 * Pair with `assembleWindow` to see what the grid would draw.
 */
export const readEventWindow = async (
  userDataDir: string,
  rangeStartUtc: number,
  rangeEndUtc: number,
): Promise<{
  readonly masters: ReadonlyArray<EventRecord>;
  readonly overrides: ReadonlyArray<EventRecord>;
  readonly singles: ReadonlyArray<EventRecord>;
}> => {
  const dbLayer = reposLayer.pipe(
    Layer.provideMerge(SqliteClient.layer({ filename: join(userDataDir, 'calendar.db') })),
    Layer.provideMerge(reactivityLayer),
  );
  return Effect.runPromise(
    Effect.flatMap(EventRepo, (events) => events.getWindow(rangeStartUtc, rangeEndUtc)).pipe(
      Effect.provide(dbLayer),
    ),
  );
};

// ---------------------------------------------------------------------------
// Agents: the gateway's own store (agents.db), seeded and read like the rest.
// ---------------------------------------------------------------------------

/** An agent as the Settings UI would have created it; `token` is what the test connects with. */
export interface AgentSeed {
  readonly name: string;
  readonly policy: AgentPolicy;
  readonly token: string;
}

/** A well-formed agent token for a seed (`sol_` + 43 characters). */
export const agentToken = (label: string): string =>
  `sol_${label
    .replaceAll(/[^\w-]/g, '')
    .padEnd(43, 'x')
    .slice(0, 43)}`;

const agentsLayer = (userDataDir: string) =>
  agentStoreLayer.pipe(
    Layer.provide(SqliteClient.layer({ filename: join(userDataDir, 'agents.db') })),
  );

export const seedAgents = async (
  userDataDir: string,
  agents: ReadonlyArray<AgentSeed>,
): Promise<void> => {
  await Effect.runPromise(
    Effect.gen(function* () {
      const repo = yield* AgentRepo;
      for (const [index, agent] of agents.entries()) {
        yield* repo.insert({
          createdAt: index + 1,
          id: `agent-${index + 1}`,
          name: agent.name,
          policy: agent.policy,
          tokenHash: yield* hashToken(agent.token),
        });
      }
    }).pipe(Effect.provide(agentsLayer(userDataDir))),
  );
};

/** The gateway's request rows (approval queue + activity log), newest first. */
export const readAgentRequests = (
  userDataDir: string,
): Promise<ReadonlyArray<AgentRequestRecord>> =>
  Effect.runPromise(
    Effect.gen(function* () {
      return yield* (yield* AgentRequestRepo).list(100);
    }).pipe(Effect.provide(agentsLayer(userDataDir))),
  );

/** The built relay script (`solunivo-cli` runs exactly this, under the app's own binary). */
export const agentRelayPath = join(import.meta.dirname, '..', 'dist-electron', 'cli.mjs');

/** The environment an agent starts the relay with. Nothing else is inherited. */
export const agentEnv = (app: App, token: string): Record<string, string> => ({
  CALENDAR_AGENT_SOCKET: app.agentSocketPath,
  PATH: process.env['PATH'] ?? '',
  SOLUNIVO_AGENT_TOKEN: token,
});

export interface CliResult {
  readonly code: number;
  readonly stderr: string;
  readonly stdout: string;
}

/** Runs one `solunivo-cli` command against the launched app, as an agent would. */
export const runAgentCli = (
  app: App,
  token: string,
  args: ReadonlyArray<string>,
): Promise<CliResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [agentRelayPath, ...args], {
      env: agentEnv(app, token),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code: code ?? -1, stderr, stdout }));
  });

// ---------------------------------------------------------------------------
// CDP client over Node's native WebSocket.
// ---------------------------------------------------------------------------

const isSettingsUrl = (url: string): boolean => /#settings(\/|$)/.test(url);

/** How long a wait keeps trying. */
export interface WaitOptions {
  /** Milliseconds; 15 s when absent. */
  readonly timeoutMs?: number;
}

/** A wait's arguments: the page function and its own, after the options if any. */
type WaitCall = ReadonlyArray<unknown>;

const splitWait = (
  call: WaitCall,
): { args: ReadonlyArray<unknown>; page: (...args: never) => unknown; timeoutMs: number } => {
  const [first, second, ...rest] = call;
  return typeof first === 'function'
    ? { args: call.slice(1), page: first as (...args: never) => unknown, timeoutMs: 15_000 }
    : {
        args: rest,
        page: second as (...args: never) => unknown,
        timeoutMs: (first as WaitOptions).timeoutMs ?? 15_000,
      };
};

/** A page function's failure, with what the page said. */
class PageError extends Error {
  constructor(
    message: string,
    /** A name the page does not have: a spec's variable the function closed over, never a passing state. */
    readonly unknownName: boolean,
  ) {
    super(message);
  }
}

/** What `noteWhen` noted in the page, by its key: the reading, or why it failed. */
type NotingWindow = typeof window & {
  __noted?: Record<string, { readonly error?: string; readonly value?: PageValue }>;
};

/**
 * `noteWhen`'s watch, set up in the page: false when `holds` already
 * does; else, at the first change of the DOM after which it does, what
 * `read` returns (or why it failed) under `key` in `window.__noted`.
 */
const watchNote = (holds: () => boolean, read: () => PageValue, key: string): boolean => {
  if (holds()) {
    return false;
  }
  const noted = ((window as NotingWindow).__noted ??= {});
  const observer = new MutationObserver(() => {
    try {
      if (!holds()) {
        return;
      }
      noted[key] = { value: read() };
    } catch (error) {
      noted[key] = { error: String(error) };
    }
    observer.disconnect();
  });
  observer.observe(document.body, {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  });
  return true;
};

/** The settings window's panes (renderer/settingsPanes.ts). */
export type SettingsPane =
  | 'accounts'
  | 'advanced'
  | 'agents'
  | 'calendar'
  | 'dictation'
  | 'file'
  | 'gettingstarted'
  | 'mirrors'
  | 'model'
  | 'notifications'
  | 'sharing'
  | 'timezones';

export class Cdp {
  private nextId = 0;
  private notes = 0;
  private readonly pending = new Map<
    number,
    { reject: (error: Error) => void; resolve: (value: unknown) => void }
  >();

  private constructor(private readonly ws: WebSocket) {
    ws.onmessage = (message) => {
      const data = JSON.parse(String(message.data)) as {
        error?: { message: string };
        id?: number;
        result?: unknown;
      };
      if (data.id !== undefined && this.pending.has(data.id)) {
        const entry = this.pending.get(data.id)!;
        this.pending.delete(data.id);
        if (data.error) {
          entry.reject(new Error(data.error.message));
        } else {
          entry.resolve(data.result);
        }
      }
    };
  }

  /**
   * Attaches to one of the app's windows: the calendar by default, the
   * settings window with `'settings'`. They are told apart by the hash
   * route the main process loads them at.
   */
  static async connect(port: number, which: 'main' | 'settings' = 'main'): Promise<Cdp> {
    // Generous: a cold macOS runner starting two Electron apps at once
    // (one per spec file) took longer than 15 s to expose a page target,
    // which failed the whole suite before a single test ran.
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const targets = (await (
          await fetch(`http://127.0.0.1:${port}/json/list`)
        ).json()) as Array<{ type: string; url: string; webSocketDebuggerUrl: string }>;
        const page = targets.find(
          (target) =>
            target.type === 'page' && isSettingsUrl(target.url) === (which === 'settings'),
        );
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error('ws connect failed'));
          });
          const cdp = new Cdp(ws);
          await cdp.send('Runtime.enable');
          await cdp.send('Page.enable');
          // The window never takes OS focus and opens behind every other
          // (CALENDAR_E2E_INPUT=cdp). The page acts as the focused one anyway
          // (focus events, :focus-visible, document.hasFocus()). Background
          // rendering is enabled separately in the window preferences.
          await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
          return cdp;
        }
      } catch {
        // devtools endpoint not up yet
      }
      if (Date.now() > deadline) {
        throw new Error('CDP page target not found');
      }
      await sleep(250);
    }
  }

  close(): void {
    this.ws.close();
  }

  get closed(): boolean {
    return this.ws.readyState !== WebSocket.OPEN;
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.nextId;
    // Mouse input in whole pixels, also from a spec's own dispatch: a
    // fractional position mis-fires, and the app takes it for the OS's
    // cursor and drops it (CALENDAR_E2E_INPUT=cdp, windows.ts).
    const sent =
      method === 'Input.dispatchMouseEvent'
        ? { ...params, x: Math.round(Number(params['x'])), y: Math.round(Number(params['y'])) }
        : params;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      this.ws.send(JSON.stringify({ id, method, params: sent }));
    });
  }

  /**
   * Runs a page function in the page (page.ts): called there with the kit
   * and `args`, each sent by value as JSON. Returns what it returns, a
   * promise awaited — JSON too, so never a DOM node.
   */
  async evaluate<A extends PageArgs, R extends PageValue | void | Promise<PageValue | void>>(
    page: PageFunction<A, R>,
    ...args: A
  ): Promise<Awaited<R>> {
    return this.run<Awaited<R>>(pageExpression(page, args));
  }

  /**
   * Polls a page function until it returns true. A failure counts as not
   * yet — during boot the page can still be about:blank, where
   * `document.body` is null and the first try throws — except a name the
   * page does not have: that is a spec's variable the function closed
   * over, so it fails at once.
   */
  waitUntil<A extends PageArgs>(page: PageFunction<A, boolean>, ...args: A): Promise<void>;
  waitUntil<A extends PageArgs>(
    options: WaitOptions,
    page: PageFunction<A, boolean>,
    ...args: A
  ): Promise<void>;
  async waitUntil(...call: WaitCall): Promise<void> {
    await this.pollPage(call, false, (value) => value === true);
  }

  /**
   * `waitUntil`, drawing a frame before each try. CDP-only test windows
   * disable background throttling, including before focus emulation is
   * attached. A screenshot also forces a fresh rendering step for layout
   * and ResizeObserver-dependent assertions.
   */
  waitUntilRendered<A extends PageArgs>(page: PageFunction<A, boolean>, ...args: A): Promise<void>;
  waitUntilRendered<A extends PageArgs>(
    options: WaitOptions,
    page: PageFunction<A, boolean>,
    ...args: A
  ): Promise<void>;
  async waitUntilRendered(...call: WaitCall): Promise<void> {
    await this.pollPage(call, true, (value) => value === true);
  }

  /**
   * Polls a page function until it returns something other than null,
   * undefined or '' (the kit's text of nothing), and returns that. Never
   * a boolean: a condition is
   * `waitUntil`'s, and the type refuses a function that returns a value
   * or a boolean, which is what a misread `??` fallback returns.
   */
  waitForValue<A extends PageArgs, R extends Exclude<PageValue, boolean>>(
    page: PageFunction<A, R | null | undefined>,
    ...args: A
  ): Promise<R>;
  waitForValue<A extends PageArgs, R extends Exclude<PageValue, boolean>>(
    options: WaitOptions,
    page: PageFunction<A, R | null | undefined>,
    ...args: A
  ): Promise<R>;
  async waitForValue(...call: WaitCall): Promise<unknown> {
    return this.pollPage(
      call,
      false,
      (value) => value !== null && value !== undefined && value !== '',
    );
  }

  private async pollPage(
    call: WaitCall,
    drawFrame: boolean,
    done: (value: unknown) => boolean,
  ): Promise<unknown> {
    const { args, page, timeoutMs } = splitWait(call);
    const expression = pageExpression(page, args);
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    for (;;) {
      try {
        if (drawFrame) {
          await this.send('Page.captureScreenshot');
        }
        const value = await this.run<unknown>(expression);
        if (done(value)) {
          return value;
        }
        lastError = '';
      } catch (error) {
        if (error instanceof PageError && error.unknownName) {
          throw error;
        }
        lastError = ` (last error: ${String(error).slice(0, 200)})`;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `wait timed out after ${String(timeoutMs)} ms: ${page.toString().slice(0, 200)} ${JSON.stringify(args).slice(0, 120)}${lastError}`,
        );
      }
      await sleep(150);
    }
  }

  private async run<T>(expression: string): Promise<T> {
    const result = (await this.send('Runtime.evaluate', {
      awaitPromise: true,
      expression,
      returnByValue: true,
    })) as {
      exceptionDetails?: {
        exception?: { className?: string; description?: string };
        text: string;
      };
      result: { value: T };
    };
    const failure = result.exceptionDetails;
    if (failure) {
      throw new PageError(
        `eval failed: ${failure.exception?.description ?? failure.text}`,
        failure.exception?.className === 'ReferenceError',
      );
    }
    return result.result.value;
  }

  /**
   * Notes what `read` evaluates to at the first change of the page after
   * which `condition` holds — in the microtask that change queues, before
   * any other task runs — and returns a reader for that value. A wait
   * and an `evaluate` after it see two commits a task apart as one on a fast
   * host and apart only on a slow one; this tells them apart on any. The
   * condition must be made true by a change of the DOM (a text, a node,
   * an attribute): an input's value is no such change, but can be read.
   * It must not hold yet: the next change, whatever it is, would note it.
   * Both are page functions, called there with a fresh kit and `args`
   * each time the observer runs.
   */
  async noteWhen<A extends PageArgs, R extends PageValue>(
    condition: PageFunction<A, boolean>,
    read: PageFunction<A, R>,
    ...args: A
  ): Promise<() => Promise<R>> {
    const key = `noted${String(++this.notes)}`;
    const called = (page: PageFunction<A, PageValue>) => `() => ${pageExpression(page, args)}`;
    const watching = await this.run<boolean>(
      `(${pageSource(watchNote)})(${called(condition)}, ${called(read)}, ${JSON.stringify(key)})`,
    );
    const said = () => `${condition.toString().slice(0, 120)} ${JSON.stringify(args).slice(0, 80)}`;
    if (!watching) {
      throw new Error(`noteWhen: the page already reads ${said()}`);
    }
    return async () => {
      const noted = await this.evaluate(
        (_: PageKit, key: string) => (window as NotingWindow).__noted?.[key] ?? null,
        key,
      );
      if (noted === null) {
        throw new Error(`noteWhen: the page never changed into ${said()}`);
      }
      if (noted.error !== undefined) {
        throw new Error(`noteWhen: reading failed: ${noted.error}`);
      }
      return noted.value as R;
    };
  }

  /**
   * Center-ish point of the nth *interactable* element matching the selector.
   * Measures only the part of the element that is on screen: the week grid
   * renders clipped pan-buffer day columns whose blocks precede the visible
   * ones in DOM order (raw indexing would target unclickable coordinates),
   * and a block can run past the grid's edge — a multi-day event that
   * starts on the week's last day reaches into next week's hidden columns,
   * so its own centre is off screen while its visible part is not. A
   * scrolling ancestor's scrollbar is not on screen either. Scrolls the
   * element into the middle of its container — on CI the week grid can
   * land scrolled differently, leaving early-morning blocks under the sticky
   * header — and hit-tests the final point so transient overlays retry
   * instead of clicking through to the wrong element.
   *
   * `avoid`: a selector for parts of the element the point must not land
   * on (a task chip's checkbox button); the point then moves along the
   * visible part until it clears them.
   */
  async locate(
    selector: string,
    options: { atBottom?: boolean; avoid?: string; index?: number } = {},
  ): Promise<{ x: number; y: number }> {
    return this.waitForValue(
      ($, selector: string, index: number, atBottom: boolean, avoid: string | null) => {
        // The element's horizontal span left once the viewport and every
        // clipping ancestor's content box (scrollbars excluded) cut it.
        const visibleSpan = (el: Element) => {
          const r = el.getBoundingClientRect();
          let left = Math.max(r.left, 0);
          let right = Math.min(r.right, window.innerWidth);
          for (let a = el.parentElement; a; a = a.parentElement) {
            if (getComputedStyle(a).overflowX !== 'visible') {
              const ar = a.getBoundingClientRect();
              const inner = ar.left + a.clientLeft;
              left = Math.max(left, inner);
              right = Math.min(right, inner + a.clientWidth);
            }
          }
          return right - left >= 8 ? { left, right } : null;
        };
        const el = $.all(selector).filter((candidate) => visibleSpan(candidate) !== null)[index];
        if (!el) {
          return null;
        }
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
        const span = visibleSpan(el);
        if (!span) {
          return null;
        }
        const r = el.getBoundingClientRect();
        const y = atBottom ? Math.floor(r.bottom) - 3 : Math.floor(r.y) + 8;
        // The middle of the visible part first; with `avoid`, further right
        // (a chip's checkbox leads it), then left of the middle.
        const fractions = avoid ? [0.5, 0.7, 0.85, 0.3] : [0.5];
        for (const fraction of fractions) {
          const x = Math.floor(span.left + (span.right - span.left) * fraction);
          const hit = document.elementFromPoint(x, y);
          if (!hit || !(el === hit || el.contains(hit) || hit.contains(el))) {
            continue;
          }
          const blocked: Element | null = avoid ? hit.closest(avoid) : null;
          if (blocked && blocked !== el && el.contains(blocked)) {
            continue;
          }
          return { x, y };
        }
        return null;
      },
      selector,
      options.index ?? 0,
      options.atBottom ?? false,
      options.avoid ?? null,
    );
  }

  /**
   * Clicks a task chip's body to open its editor: on the chip wherever its
   * column is, never on its leading checkbox (a click there completes the
   * task). A fixed offset from the chip's centre fell under the week grid's
   * scrollbar when the chip sat in the last column — every Sunday.
   */
  async clickTaskChip(selector: string): Promise<void> {
    const body = await this.locate(selector, { avoid: 'button' });
    await this.click(body.x, body.y);
  }

  async mouse(
    type: 'mouseMoved' | 'mousePressed' | 'mouseReleased',
    x: number,
    y: number,
  ): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      button: 'left',
      buttons: type === 'mouseReleased' ? 0 : 1,
      clickCount: 1,
      pointerType: 'mouse',
      type,
      x,
      y,
    });
  }

  /**
   * Dispatches a single trackpad-style wheel event at the given point via
   * the native input pipeline (real scrolling side effects). Do NOT use for
   * bursts: after a few dozen synthetic mouseWheel dispatches Chromium's
   * input pipeline stops acknowledging them and the CDP call hangs forever —
   * use wheelBurst for gesture streams instead.
   */
  async wheel(x: number, y: number, deltaX: number, deltaY: number): Promise<void> {
    await this.send('Input.dispatchMouseEvent', {
      deltaX,
      deltaY,
      pointerType: 'mouse',
      type: 'mouseWheel',
      x,
      y,
    });
  }

  /**
   * Fires a stream of JS-synthesized wheel events at the first element
   * matching the selector — a trackpad gesture as the app's non-passive
   * wheel listener sees it. Untrusted events skip native scrolling, which is
   * exactly what makes them hang-proof (no input-pipeline ACKs involved).
   */
  async wheelBurst(
    selector: string,
    options: { count: number; deltaX: number; deltaY?: number; gapMs?: number },
  ): Promise<void> {
    await this.evaluate(
      async ($, selector: string, count: number, deltaX: number, deltaY: number, gapMs: number) => {
        const target = $.el(selector);
        if (!target) {
          throw new Error('wheelBurst: no element for selector');
        }
        const rect = target.getBoundingClientRect();
        for (let index = 0; index < count; index += 1) {
          target.dispatchEvent(
            new WheelEvent('wheel', {
              bubbles: true,
              cancelable: true,
              clientX: Math.floor(rect.x + rect.width / 2),
              clientY: Math.floor(rect.y + rect.height / 2),
              deltaX,
              deltaY,
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, gapMs));
        }
      },
      selector,
      options.count,
      options.deltaX,
      options.deltaY ?? 0,
      options.gapMs ?? 20,
    );
  }

  async click(x: number, y: number): Promise<void> {
    await this.mouse('mousePressed', x, y);
    await this.mouse('mouseReleased', x, y);
  }

  /** Presses, moves in steps, releases — a real drag. */
  async drag(
    from: { x: number; y: number },
    to: { x: number; y: number },
    steps = 8,
  ): Promise<void> {
    await this.mouse('mousePressed', from.x, from.y);
    for (let step = 1; step <= steps; step += 1) {
      await this.mouse(
        'mouseMoved',
        Math.round(from.x + ((to.x - from.x) * step) / steps),
        Math.round(from.y + ((to.y - from.y) * step) / steps),
      );
      await sleep(20);
    }
    await this.mouse('mouseReleased', to.x, to.y);
  }

  async pressEscape(): Promise<void> {
    await this.send('Input.dispatchKeyEvent', {
      code: 'Escape',
      key: 'Escape',
      type: 'rawKeyDown',
      windowsVirtualKeyCode: 27,
    });
  }

  /** Tab, or Shift+Tab: the browser moves focus as it would for the real key. */
  async pressTab(shift = false): Promise<void> {
    await this.send('Input.dispatchKeyEvent', {
      code: 'Tab',
      key: 'Tab',
      modifiers: shift ? 8 : 0,
      type: 'rawKeyDown',
      windowsVirtualKeyCode: 9,
    });
  }

  /** Focuses the element and types text into it (React-compatible). */
  async type(selector: string, text: string): Promise<void> {
    await this.evaluate(($, field: string) => $.el(field)?.focus(), selector);
    await this.send('Input.insertText', { text });
  }

  /** Return, as the key itself, to whatever has the focus. */
  async pressEnter(): Promise<void> {
    await this.send('Input.dispatchKeyEvent', {
      code: 'Enter',
      key: 'Enter',
      type: 'rawKeyDown',
      windowsVirtualKeyCode: 13,
    });
  }

  /**
   * Says a phrase to the editor's Assistant: typed into its field and sent
   * with Return. The field is in the view the editor opens a new item on;
   * `showEditorView('assistant')` brings it forward from the form.
   */
  async say(phrase: string): Promise<void> {
    await this.type('[data-testid="quick-add-input"]', phrase);
    await this.pressEnter();
  }

  /**
   * Brings one of the editor's two views forward, by its tab, and waits
   * until it is the one on show and the switch's motion has ended
   * (`data-switching`): the pane leaving is still drawn until then.
   */
  async showEditorView(view: 'assistant' | 'form'): Promise<void> {
    await this.clickTestId(`editor-view-${view}`);
    await this.waitUntil(($, shown: string) => {
      const editor = $.el('[data-testid="editor"]');
      return editor?.dataset['view'] === shown && !editor.hasAttribute('data-switching');
    }, view);
  }

  /** Answers an editor's delete confirmation (MoveConfirm) with Delete. */
  async confirmDelete(): Promise<void> {
    await this.waitUntil(($) => $.has('[data-testid="move-confirm-yes"]'));
    await this.evaluate(($) => $.el('[data-testid="move-confirm-yes"]')!.click());
  }

  /**
   * Leaves the open editor without saving, by Escape: one that holds
   * something (an edit, a draft, words in the Assistant's field) asks
   * first (`DiscardConfirm`), and is answered Discard Changes.
   */
  async discardEditor(): Promise<void> {
    await this.pressEscape();
    await this.waitUntil(
      ($) => !$.has('[data-testid="editor"]') || $.has('[data-testid="discard-confirm-yes"]'),
    );
    await this.evaluate(($) => $.el('[data-testid="discard-confirm-yes"]')?.click());
    await this.waitUntil(($) => !$.has('[data-testid="editor"]'));
  }

  /**
   * One step of a cleanup loop that leaves whatever is open: Discard
   * Changes while an editor asks (`DiscardConfirm`), else Escape — which,
   * pressed while it asks, would answer Keep Editing instead.
   */
  async escapeOrDiscard(): Promise<void> {
    const answered = await this.evaluate(($) => {
      const yes = $.el('[data-testid="discard-confirm-yes"]');
      yes?.click();
      return yes !== null;
    });
    if (!answered) {
      await this.pressEscape();
    }
  }

  /** Answers the editor's question before it goes (`DiscardConfirm`): Discard Changes, or Keep Editing. */
  async answerDiscard(discard: boolean): Promise<void> {
    const answer = `[data-testid="discard-confirm-${discard ? 'yes' : 'no'}"]`;
    await this.waitUntil(($, button: string) => $.has(button), answer);
    await this.evaluate(($, button: string) => $.el(button)!.click(), answer);
    await this.waitUntil(($) => !$.has('[data-testid="discard-confirm"]'));
  }

  /** Clicks an event on the grid and waits for its inspector in the side panel. */
  async openInspector(selector: string): Promise<void> {
    const block = await this.locate(selector);
    await this.click(block.x, block.y);
    await this.waitUntil(($) => $.has('[data-testid="inspector"]'));
  }

  /** Opens an event's editor: the grid click, then the inspector's Edit button. */
  async openEditor(selector: string): Promise<void> {
    await this.openInspector(selector);
    await this.clickTestId('inspector-edit');
    await this.waitUntil(($) => $.text('[data-testid="editor-title"]') === 'Edit event');
  }

  /** Shows the Today rail if the window is too narrow for it to be open by itself. */
  async showRail(): Promise<void> {
    if (await this.evaluate(($) => $.has('[data-panel-kind="rail"]'))) {
      return;
    }
    await this.clickTestId('panel-toggle');
    await this.waitUntil(($) => $.has('[data-panel-kind="rail"]'));
  }

  /** Clicks the element carrying a `data-testid`, scrolled into view and hit-tested. */
  async clickTestId(id: string): Promise<void> {
    const target = await this.locate(`[data-testid=${JSON.stringify(id)}]`);
    await this.click(target.x, target.y);
  }

  async clickButtonWithText(text: string): Promise<void> {
    await this.waitUntil(($, label: string) => $.button(label) !== null, text);
    await this.evaluate(($, label: string) => $.button(label)?.click(), text);
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

export interface App {
  /** Where this run's agent gateway listens (once an agent exists). */
  readonly agentSocketPath: string;
  readonly cdp: Cdp;
  /** Closes the settings window, if one is open. */
  readonly closeSettings: () => Promise<void>;
  readonly dump: (label: string) => Promise<void>;
  /**
   * Holds or lets go of the Reminders and Apple Calendar fixtures' writes
   * (eventKitHold.ts reads the marker file): while held, a save or delete
   * waits for its reply as on a slow EventKit.
   */
  readonly holdEventKitWrites: (held: boolean) => void;
  /**
   * Opens the settings window on a pane — through the main window's bridge,
   * as its buttons do — and returns a client attached to it. An open
   * window is moved to the pane and its client reused.
   */
  readonly openSettings: (pane: SettingsPane) => Promise<Cdp>;
  /** The isolated app's debugging endpoint, for external drivers such as Bombadil. */
  readonly remoteDebugger: string;
  /**
   * Starts or ends a screen capture as the app sees one — needs
   * `captureWatch: 'fixture'` (captureHint.ts reads the marker file).
   */
  readonly setCapturing: (active: boolean) => void;
  /** Where this run's watched settings file lives (may not exist). */
  readonly settingsFilePath: string;
  /** A client attached to the settings window something else opened (a button, the menu). */
  readonly settingsPage: () => Promise<Cdp>;
  readonly stop: () => Promise<void>;
  readonly userDataDir: string;
  /** How many windows the app has open (the calendar, settings). */
  readonly windowCount: () => Promise<number>;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The port Chromium bound for `--remote-debugging-port=0`, read from the
 * line it prints on stderr: "DevTools listening on ws://127.0.0.1:<port>/…".
 * Gives up when the app exits first, or after Cdp.connect's minute.
 */
const devToolsPort = (child: ChildProcess): Promise<number> =>
  new Promise((resolve, reject) => {
    let seen = '';
    const done = () => {
      clearTimeout(timer);
      child.stderr?.off('data', read);
      child.off('exit', exited);
    };
    const read = (chunk: Buffer) => {
      // A chunk may end mid-line, so the match runs on everything so far.
      seen += chunk.toString();
      const port = /DevTools listening on ws:\/\/[^/]+:(\d+)\//.exec(seen)?.[1];
      if (port) {
        done();
        resolve(Number(port));
      }
    };
    const exited = (code: number | null) => {
      done();
      reject(new Error(`app exited (${String(code)}) before DevTools listened`));
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error('DevTools never named its port'));
    }, 60_000);
    child.stderr?.on('data', read);
    child.once('exit', exited);
  });

/** A fake device address book the app loads instead of the helper (no TCC, no real data). */
export interface ContactsFixture {
  readonly birthdays?: ReadonlyArray<DeviceBirthdayJson>;
  readonly contacts?: ReadonlyArray<DeviceContactJson>;
}

/** An in-memory Calendar app (EventKit events) instead of the helper: no TCC, no real calendars. */
export interface AppleCalendarFixture {
  readonly calendars: ReadonlyArray<AppleCalendarJson>;
  readonly events?: ReadonlyArray<FakeEventSeed>;
}

export interface GeoFixture {
  readonly places: ReadonlyArray<FakePlace>;
}

export interface RemindersFixture {
  readonly lists?: ReadonlyArray<ReminderListJson>;
  readonly reminders?: ReadonlyArray<ReminderJson>;
}

/** The environment for `LaunchOptions.assistantModel`. */
const assistantModelEnv = (
  choice: LaunchOptions['assistantModel'],
): Readonly<Record<string, string>> =>
  choice === undefined || choice === 'off'
    ? { CALENDAR_ASSISTANT_MODEL: 'off' }
    : 'file' in choice
      ? { CALENDAR_ASSISTANT_MODEL_FILE: choice.file }
      : {
          CALENDAR_ASSISTANT_MANIFEST: choice.manifest,
          ...(choice.llamaServer === undefined
            ? {}
            : { CALENDAR_LLAMA_SERVER: choice.llamaServer }),
        };

export interface LaunchOptions {
  /**
   * Agents present at launch (the gateway only listens while one exists).
   * Their socket always lives under the run's temp profile
   * (CALENDAR_AGENT_SOCKET), never in the developer's ~/.solunivo.
   */
  readonly agents?: ReadonlyArray<AgentSeed>;
  /**
   * 'off' (default): no calendar bridge. 'real': the helper. A fixture: the
   * in-memory EventKit — Apple events live nowhere else, so this is how e2e
   * sees them without reading a developer's calendars.
   */
  readonly appleCalendar?: 'off' | 'real' | { readonly fixture: AppleCalendarFixture };
  /**
   * 'off' (default): the Assistant's own model is left out — nothing
   * offered, nothing downloaded (`CALENDAR_ASSISTANT_MODEL=off`); under
   * `model: 'fixture'` the fixture answers it anyway. `{ file }`: that
   * GGUF in place of the download, run by the built llama-server.
   * `{ manifest }`: the download from that manifest (a file served from
   * this Mac); `llamaServer` stands in for the built llama-server, which
   * CI's build has none of (`CALENDAR_LLAMA_SERVER`).
   */
  readonly assistantModel?:
    | 'off'
    | { readonly file: string }
    | { readonly llamaServer?: string; readonly manifest: string };
  /**
   * Absent (default): no camera (CALENDAR_CAMERA=off) — the settings-code
   * reader offers its paste field only and nothing asks TCC. Present: the
   * camera is granted without asking, each window's `getUserMedia` answers
   * a drawn canvas stream (`fakeCamera`), and every frame reads as `code`.
   * The helper's own reading (Vision) is proven in qrReader.e2e.ts.
   */
  readonly camera?: { readonly code: string };
  /**
   * 'off' (default): the app never watches for screen captures, so a
   * developer's screenshot mid-run cannot draw the capture hint. 'fixture':
   * captures start and end through `App.setCapturing`.
   */
  readonly captureWatch?: 'fixture' | 'off';
  /**
   * 'off' (default): no bridge at all. 'real': the helper. A fixture: the
   * in-memory fake client seeded with these rows — the only way e2e sees
   * device contacts or birthdays without touching a developer's address book.
   */
  readonly contacts?: 'off' | 'real' | { readonly fixture: ContactsFixture };
  /** A spec's own variables for the app process (`TZ` pins the device zone); the isolation below still wins. */
  readonly env?: Readonly<Record<string, string>>;
  /**
   * 'off' (default): no MapKit, so no suggestions and no map. 'real': the
   * helper (network-dependent). A fixture: the in-memory geo client with
   * these places and a constant map image — deterministic and offline.
   */
  readonly geo?: 'off' | 'real' | { readonly fixture: GeoFixture };
  /**
   * Absent (default): the real Google clients — a seeded account has no
   * token, so its writes stay queued. A fixture runs the in-process fake
   * Google API with a token for every signed-in fixture account: lists and
   * tasks arrive through the first sync and queued writes push, so e2e can
   * watch a temp `local-…` id become a server id. `live` signs the real
   * API in as the live test account (googleLive.e2e.ts only): the seed
   * goes into a JSON file in the run's userData dir, the OAuth client
   * into the env, and the poll can be shortened.
   */
  readonly google?: { readonly fixture: GoogleFixture } | { readonly live: LiveGoogleLaunch };
  /**
   * Absent (default): dictation is the Mac's — its microphone, its speech
   * models. Present: the page's microphone plays a loop of a phrase-long
   * tone between stretches of quiet room (`dictationAudio`); while the
   * tone plays, main writes the next of `phrases` word by word, and the
   * phrase is read as it — a spec dictates in the fixture model's
   * grammar, with no TCC prompt and no developer's room. A phrase given as
   * segments is read as them, the other readings the recogniser weighed
   * for each included.
   * (Chromium's fake audio device never opens under Electron here, so
   * `getUserMedia` itself is stood in for, in the page.)
   */
  readonly microphone?: {
    readonly phrases: ReadonlyArray<
      string | { readonly segments: ReadonlyArray<TranscriptSegment> }
    >;
  };
  /**
   * Absent (default): the real helper, so the ⌘K bar shows whatever this
   * machine's Apple Intelligence allows. 'fixture': the deterministic model
   * and text recognizer from @calendar/ai answer in the main process, so a
   * spec can paste a text in the fixture grammar and assert the events.
   */
  readonly model?: 'fixture';
  /**
   * The served-model provider as the app finds it on launch (its
   * `model-provider.json`): a spec's own fake server on this machine. Not
   * with `model: 'fixture'`, which answers before any provider.
   */
  readonly modelProvider?: {
    readonly baseUrl: string;
    readonly kind: 'ollama' | 'openai';
    readonly model: string;
  };
  /**
   * 'off' (default): no first-run setup dialog and no Getting started card
   * (CALENDAR_ONBOARDING=off) — a seeded profile with no account would
   * otherwise open the setup over the calendar. 'on': the onboarding spec.
   */
  readonly onboarding?: 'off' | 'on';
  /**
   * 'off' (default): no EventKit. 'real': the helper. A fixture uses the
   * in-memory Reminders client so mutation e2e tests never touch personal data.
   */
  readonly reminders?: 'off' | 'real' | { readonly fixture: RemindersFixture };
  /**
   * Initial text of the watched settings file. The file always lives under
   * the run's temp profile (CALENDAR_SETTINGS_FILE), never at the
   * developer's ~/.solunivo — absent means the app starts without one.
   */
  readonly settingsFile?: string;
  /** The main window's size; CI's runner screen is 1024 wide, so a spec can ask for that. */
  readonly window?: { readonly height: number; readonly width: number };
}

export interface LiveGoogleLaunch extends LiveAccountSeed {
  readonly clientId: string;
  readonly clientSecret?: string | undefined;
  /** Overrides the 90 s poll so a pull lands inside a test's timeout. */
  readonly syncIntervalMs?: number | undefined;
}

const DICTATION_SAMPLE_RATE = 16_000;
/** The sample at `ms` into the fixture microphone's loop. */
const sampleAt = (ms: number) => Math.round((DICTATION_SAMPLE_RATE * ms) / 1000);
/** The fixture microphone's loop: quiet room, a phrase, then a pause long enough to end it. */
export const DICTATION_LOOP_MS = { phrase: 1200, quietAfter: 2500, quietBefore: 800 } as const;

/**
 * One loop of the fixture microphone: a quiet room's noise (about -60
 * dBFS), a phrase-long tone over it (about -23 dBFS), then the room again
 * for longer than the pause that ends a phrase. Deterministic: the same
 * samples every run.
 */
const dictationAudio = (): Float32Array => {
  const { phrase, quietAfter, quietBefore } = DICTATION_LOOP_MS;
  const samples = new Float32Array(sampleAt(quietBefore + phrase + quietAfter));
  let seed = 1;
  const noise = () => {
    seed = (seed * 16_807) % 2_147_483_647;
    return (seed / 2_147_483_647 - 0.5) * 0.002;
  };
  for (let index = 0; index < samples.length; index += 1) {
    const speaking = index >= sampleAt(quietBefore) && index < sampleAt(quietBefore + phrase);
    samples[index] =
      noise() +
      (speaking ? 0.1 * Math.sin((2 * Math.PI * 220 * index) / DICTATION_SAMPLE_RATE) : 0);
  }
  return samples;
};

/**
 * The page's microphone, stood in for: each `getUserMedia` answers a fresh
 * stream of one looping buffer of `dictationAudio`, played through Web
 * Audio — the same samples every run, whatever the room.
 */
const fakeMicrophone = (_: PageKit, sampleRate: number, base64: string): void => {
  const context = new AudioContext({ sampleRate });
  const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
  const samples = new Float32Array(bytes.buffer);
  const buffer = context.createBuffer(1, samples.length, context.sampleRate);
  buffer.copyToChannel(samples, 0);
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.start();
  navigator.mediaDevices.getUserMedia = async () => {
    const stream = context.createMediaStreamDestination();
    source.connect(stream);
    return stream.stream;
  };
};

/**
 * The page's camera, stood in for: `getUserMedia` answers a 640×480
 * canvas stream that keeps drawing (a frame the reader can encode); what
 * it "sees" is up to CALENDAR_CAMERA_CODE in the main process.
 */
const fakeCamera = (): void => {
  navigator.mediaDevices.getUserMedia = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 480;
    const context = canvas.getContext('2d')!;
    let tick = 0;
    setInterval(() => {
      tick += 1;
      context.fillStyle = tick % 2 ? '#fff' : '#eee';
      context.fillRect(0, 0, 640, 480);
    }, 50);
    return canvas.captureStream(20);
  };
};

/** One window's DOM and screenshot, for a failed test's artifacts. */
const dumpPage = async (page: Cdp, dir: string, name: string) => {
  try {
    const html = await page.evaluate(() => document.body.outerHTML);
    writeFileSync(join(dir, `${name}.html`), html);
    const shot = (await page.send('Page.captureScreenshot')) as { data?: string };
    if (shot.data) {
      writeFileSync(join(dir, `${name}.png`), Buffer.from(shot.data, 'base64'));
    }
  } catch (error) {
    // A dead renderer is exactly when the log above matters most — record
    // why the richer artifacts couldn't be captured instead of hiding it.
    writeFileSync(join(dir, `${name}.dump-error.txt`), String(error));
  }
};

export const launchApp = async (seed?: SeedData, options: LaunchOptions = {}): Promise<App> => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'calendar-e2e-'));
  if (seed) {
    await seedDatabase(userDataDir, seed);
  }
  if (options.agents) {
    await seedAgents(userDataDir, options.agents);
  }
  // Like the settings file: HOME is not isolated, so the agent socket is
  // pinned inside the temp profile for every run, agents or not.
  const agentSocketPath = join(userDataDir, 'agent.sock');
  const contactsEnv: Record<string, string> =
    options.contacts === 'real'
      ? {}
      : options.contacts === undefined || options.contacts === 'off'
        ? { CALENDAR_CONTACTS: 'off' }
        : (() => {
            const fixturePath = join(userDataDir, 'contacts-fixture.json');
            writeFileSync(fixturePath, JSON.stringify(options.contacts.fixture));
            return { CALENDAR_CONTACTS: 'fixture', CALENDAR_CONTACTS_FIXTURE: fixturePath };
          })();
  const remindersEnv: Record<string, string> =
    options.reminders === 'real'
      ? {}
      : options.reminders === undefined || options.reminders === 'off'
        ? { CALENDAR_REMINDERS: 'off' }
        : (() => {
            const fixturePath = join(userDataDir, 'reminders-fixture.json');
            writeFileSync(fixturePath, JSON.stringify(options.reminders.fixture));
            return {
              CALENDAR_REMINDERS: 'fixture',
              CALENDAR_REMINDERS_FIXTURE: fixturePath,
            };
          })();

  const appleCalendarEnv: Record<string, string> =
    options.appleCalendar === 'real'
      ? {}
      : options.appleCalendar === undefined || options.appleCalendar === 'off'
        ? { CALENDAR_APPLE_CALENDAR: 'off' }
        : (() => {
            const fixturePath = join(userDataDir, 'apple-calendar-fixture.json');
            writeFileSync(fixturePath, JSON.stringify(options.appleCalendar.fixture));
            return {
              CALENDAR_APPLE_CALENDAR: 'fixture',
              CALENDAR_APPLE_CALENDAR_FIXTURE: fixturePath,
            };
          })();

  const googleEnv: Record<string, string> = !options.google
    ? {}
    : 'fixture' in options.google
      ? (() => {
          const fixturePath = join(userDataDir, 'google-fixture.json');
          writeFileSync(fixturePath, JSON.stringify(options.google.fixture));
          return { CALENDAR_GOOGLE: 'fixture', CALENDAR_GOOGLE_FIXTURE: fixturePath };
        })()
      : (() => {
          const { clientId, clientSecret, syncIntervalMs, ...seed } = options.google.live;
          // The refresh token lives only here, inside the temp profile
          // stop() deletes — never on the command line.
          const livePath = join(userDataDir, 'google-live.json');
          writeFileSync(livePath, JSON.stringify(seed), { mode: 0o600 });
          return {
            CALENDAR_GOOGLE: 'live',
            CALENDAR_GOOGLE_LIVE: livePath,
            GOOGLE_DESKTOP_CLIENT_ID: clientId,
            ...(clientSecret ? { GOOGLE_DESKTOP_CLIENT_SECRET: clientSecret } : {}),
            ...(syncIntervalMs ? { CALENDAR_SYNC_INTERVAL_MS: String(syncIntervalMs) } : {}),
          };
        })();

  const geoEnv: Record<string, string> =
    options.geo === 'real'
      ? {}
      : options.geo === undefined || options.geo === 'off'
        ? { CALENDAR_GEO: 'off' }
        : (() => {
            const fixturePath = join(userDataDir, 'geo-fixture.json');
            writeFileSync(fixturePath, JSON.stringify(options.geo.fixture));
            return { CALENDAR_GEO: 'fixture', CALENDAR_GEO_FIXTURE: fixturePath };
          })();

  if (options.modelProvider) {
    writeFileSync(join(userDataDir, 'model-provider.json'), JSON.stringify(options.modelProvider));
  }

  const microphoneEnv: Record<string, string> = options.microphone
    ? (() => {
        const fixturePath = join(userDataDir, 'microphone-fixture.json');
        writeFileSync(fixturePath, JSON.stringify({ phrases: options.microphone.phrases }));
        return { CALENDAR_MICROPHONE: 'fixture', CALENDAR_MICROPHONE_FIXTURE: fixturePath };
      })()
    : {};

  // The watched settings file stays inside the temp profile: HOME is not
  // isolated here, and a run must never read or rewrite a developer's file.
  const settingsFilePath = join(userDataDir, 'solunivo.jsonc');
  if (options.settingsFile !== undefined) {
    writeFileSync(settingsFilePath, options.settingsFile);
  }

  const electronPath = require('electron') as unknown as string;
  const appDir = join(import.meta.dirname, '..');
  // Port 0: Chromium binds a free port and names it on stderr
  // (devToolsPort). A port picked here at random could belong to another
  // spec's app, still running, and the spec drove that one.
  // Chromium's mock keychain keeps safeStorage off the login keychain: a
  // run never reads a developer's "Electron Safe Storage" key, and a new
  // Electron binary never stops a run on macOS's keychain access dialog
  // (it did, after the Electron 45 bump: every safeStorage call blocked
  // until the dialog was answered).
  const child: ChildProcess = spawn(
    electronPath,
    [appDir, '--remote-debugging-port=0', '--use-mock-keychain'],
    {
      env: {
        ...process.env,
        ...options.env,
        // Seeded Apple rows must not be replaced by (or prompt for) the
        // developer's real Reminders — see remindersClient.ts.
        ...remindersEnv,
        // Likewise the Calendar app's events: never a developer's, never a prompt.
        ...appleCalendarEnv,
        // Likewise the address book: no TCC prompt, no developer's contacts.
        ...contactsEnv,
        // And MapKit: no network lookups, so no run depends on Apple's servers.
        ...geoEnv,
        // Google, when a spec asks for it: the in-process fake API.
        ...googleEnv,
        // And the microphone, when a spec dictates: a file, never the room.
        ...microphoneEnv,
        ...(options.model === 'fixture' ? { CALENDAR_MODEL: 'fixture' } : {}),
        CALENDAR_AGENT_SOCKET: agentSocketPath,
        // The Assistant's own model: off unless a spec points it at a file.
        ...assistantModelEnv(options.assistantModel),
        // No camera, no TCC prompt, unless a spec stands one in.
        CALENDAR_CAMERA: options.camera ? 'fixture' : 'off',
        ...(options.camera ? { CALENDAR_CAMERA_CODE: options.camera.code } : {}),
        CALENDAR_CAPTURE_WATCH: options.captureWatch ?? 'off',
        // The windows take no OS input: a developer typing or touching the
        // trackpad during a run must not reach the test (windows.ts).
        CALENDAR_E2E_INPUT: 'cdp',
        // The marker the EventKit fixtures' writes wait on (holdEventKitWrites).
        CALENDAR_EVENTKIT_HOLD: join(userDataDir, 'eventkit-hold'),
        // A seeded birthday with reminders on must never post a real banner.
        CALENDAR_NOTIFICATIONS: 'off',
        // No setup dialog and no Getting started card unless a spec asks.
        CALENDAR_ONBOARDING: options.onboarding ?? 'off',
        CALENDAR_SETTINGS_FILE: settingsFilePath,
        CALENDAR_USERDATA: userDataDir,
        ...(options.window
          ? {
              CALENDAR_E2E_WINDOW: `${String(options.window.width)}x${String(options.window.height)}`,
            }
          : {}),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  // Keep everything the app writes: on a red run the only other signal is a
  // bare vitest timeout. Bootstrap failures are also surfaced immediately.
  const appLog: Array<string> = [];
  const record = (stream: string) => (chunk: Buffer) => {
    const text = chunk.toString();
    appLog.push(`[${stream}] ${text}`);
    if (text.includes('bootstrap failed')) {
      console.error('[e2e app]', text);
    }
  };
  child.stdout?.on('data', record('out'));
  child.stderr?.on('data', record('err'));
  const announced = devToolsPort(child);

  let port: number;
  let cdp: Cdp;
  try {
    port = await announced;
    cdp = await Cdp.connect(port);
    // Wait for the calendar shell to render.
    await cdp.waitUntil(() => document.body.textContent.includes('Today'));
    if (options.microphone) {
      await cdp.evaluate(
        fakeMicrophone,
        DICTATION_SAMPLE_RATE,
        Buffer.from(dictationAudio().buffer).toString('base64'),
      );
    }
    if (options.camera) {
      await cdp.evaluate(fakeCamera);
    }
  } catch (error) {
    // A launch failure happens in beforeAll, where no test dump runs:
    // the app's own output is the only clue, so put it in the run log.
    console.error('[e2e app] launch failed; app output follows\n', appLog.join('').slice(-4000));
    child.kill();
    throw error;
  }

  let settings: Cdp | null = null;
  const settingsPage = async (): Promise<Cdp> => {
    if (!settings || settings.closed) {
      settings = await Cdp.connect(port, 'settings');
      await settings.waitUntil(($) => $.has('[data-testid="settings-window"]'));
    }
    return settings;
  };

  return {
    agentSocketPath,
    cdp,
    closeSettings: async () => {
      if (!settings || settings.closed) {
        settings = null;
        return;
      }
      const page = settings;
      settings = null;
      // The reply may never come: the page is gone once this runs.
      void page.send('Page.close').catch(() => {});
      const deadline = Date.now() + 10_000;
      while (!page.closed) {
        if (Date.now() > deadline) {
          throw new Error('settings window did not close');
        }
        await sleep(50);
      }
    },
    remoteDebugger: `http://127.0.0.1:${port}`,
    /** Screenshot + DOM (of each open window) + app log, for CI to upload when a test fails. */
    dump: async (label: string) => {
      const dir = join(import.meta.dirname, '..', 'e2e-artifacts');
      mkdirSync(dir, { recursive: true });
      const safe = label.replaceAll(/[^a-z0-9]+/gi, '-').slice(0, 80);
      writeFileSync(join(dir, `${safe}.log`), appLog.join(''));
      await dumpPage(cdp, dir, safe);
      if (settings && !settings.closed) {
        await dumpPage(settings, dir, `${safe}.settings`);
      }
    },
    holdEventKitWrites: (held: boolean) => {
      // The marker eventKitHold.ts polls (CALENDAR_EVENTKIT_HOLD).
      const marker = join(userDataDir, 'eventkit-hold');
      if (held) {
        writeFileSync(marker, '');
      } else {
        rmSync(marker, { force: true });
      }
    },
    openSettings: async (pane: SettingsPane) => {
      await cdp.evaluate(
        (_, shown: SettingsPane) => window.calendarBridge.openSettings(shown),
        pane,
      );
      const page = await settingsPage();
      await page.waitUntil(
        ($, shown: SettingsPane) =>
          $.el(`[data-testid="settings-pane-${shown}"]`)?.hidden === false,
        pane,
      );
      if (options.camera) {
        await page.evaluate(fakeCamera);
      }
      return page;
    },
    setCapturing: (active: boolean) => {
      // The marker captureHint.ts polls under CALENDAR_CAPTURE_WATCH=fixture.
      const marker = join(userDataDir, 'capture-active');
      if (active) {
        writeFileSync(marker, '');
      } else {
        rmSync(marker, { force: true });
      }
    },
    settingsFilePath,
    settingsPage,
    stop: async () => {
      settings?.close();
      cdp.close();
      // Wait for the process to actually exit — deleting the profile while
      // Electron flushes it races into ENOTEMPTY on slower CI runners.
      const exited = new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
        setTimeout(resolve, 3000);
      });
      child.kill();
      await exited;
      rmSync(userDataDir, { force: true, maxRetries: 5, recursive: true, retryDelay: 200 });
    },
    userDataDir,
    windowCount: async () => {
      const targets = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
        type: string;
      }>;
      return targets.filter((target) => target.type === 'page').length;
    },
  };
};
