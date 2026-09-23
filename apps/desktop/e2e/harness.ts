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
import type { AppleCalendarJson, FakeEventSeed } from '@calendar/apple-calendar';
import type { DeviceBirthdayJson, DeviceContactJson } from '@calendar/contacts';
import type { FakePlace } from '@calendar/geo';
import type { ReminderJson, ReminderListJson } from '@calendar/reminders';
import type { GoogleFixture } from '@calendar/sync/testing/googleFixture';
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
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';
import { SqlClient } from 'effect/unstable/sql/SqlClient';

const require = createRequire(import.meta.url);

/* eslint-disable no-console -- harness diagnostics are wanted in e2e output */

/**
 * The *local* ISO date `days` before today (negative = ahead), for
 * date-only seeds: the app places a task on the day in the machine's zone,
 * and between local midnight and UTC midnight the UTC date is still
 * yesterday (CI runs in UTC; dev does not).
 */
export const localIsoDaysAgo = (days: number): string => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
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
      return yield* (yield* TaskRepo).getWindow('0000-01-01', '9999-12-31');
    }).pipe(Effect.provide(dbLayer)),
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

// ---------------------------------------------------------------------------
// CDP client over Node's native WebSocket.
// ---------------------------------------------------------------------------

export class Cdp {
  private nextId = 0;
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

  static async connect(port: number): Promise<Cdp> {
    // Generous: a cold macOS runner starting two Electron apps at once
    // (one per spec file) took longer than 15 s to expose a page target,
    // which failed the whole suite before a single test ran.
    const deadline = Date.now() + 60_000;
    for (;;) {
      try {
        const targets = (await (
          await fetch(`http://127.0.0.1:${port}/json/list`)
        ).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
        const page = targets.find((target) => target.type === 'page');
        if (page) {
          const ws = new WebSocket(page.webSocketDebuggerUrl);
          await new Promise<void>((resolve, reject) => {
            ws.onopen = () => resolve();
            ws.onerror = () => reject(new Error('ws connect failed'));
          });
          const cdp = new Cdp(ws);
          await cdp.send('Runtime.enable');
          await cdp.send('Page.enable');
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

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { reject, resolve });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluates an expression, returning its JSON value. */
  async eval<T>(expression: string): Promise<T> {
    const result = (await this.send('Runtime.evaluate', {
      awaitPromise: true,
      expression,
      returnByValue: true,
    })) as { exceptionDetails?: { text: string }; result: { value: T } };
    if (result.exceptionDetails) {
      throw new Error(`eval failed: ${result.exceptionDetails.text}`);
    }
    return result.result.value;
  }

  /**
   * Polls an expression until it is truthy; returns its value. Evaluation
   * errors count as "not ready yet" and keep polling: during boot the page
   * can still be about:blank, where `document.body` is null and the very
   * first eval throws — a hard throw there would kill the whole run.
   */
  async waitFor<T>(expression: string, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    let lastError = '';
    for (;;) {
      try {
        const value = await this.eval<T>(expression);
        if (value) {
          return value;
        }
        lastError = '';
      } catch (error) {
        lastError = ` (last error: ${String(error).slice(0, 120)})`;
      }
      if (Date.now() > deadline) {
        throw new Error(`waitFor timed out: ${expression.slice(0, 120)}${lastError}`);
      }
      await sleep(150);
    }
  }

  /**
   * Center-ish point of the nth *interactable* element matching the selector.
   * Skips elements outside the horizontal viewport — the week grid renders
   * clipped pan-buffer day columns whose blocks precede the visible ones in
   * DOM order, so raw indexing would target unclickable coordinates. Scrolls
   * the element into the middle of its container — on CI the week grid can
   * land scrolled differently, leaving early-morning blocks under the sticky
   * header — and hit-tests the final point so transient overlays retry
   * instead of clicking through to the wrong element.
   */
  async locate(
    selector: string,
    options: { atBottom?: boolean; index?: number } = {},
  ): Promise<{ x: number; y: number }> {
    const point = await this.waitFor<string>(`(() => {
      const horizontallyVisible = (el) => {
        const r = el.getBoundingClientRect();
        const centerX = r.x + r.width / 2;
        if (centerX < 0 || centerX > window.innerWidth) return false;
        // Clipped by any overflow ancestor (e.g. the pan-buffer day columns
        // hidden behind the week grid's viewport)?
        for (let a = el.parentElement; a; a = a.parentElement) {
          if (getComputedStyle(a).overflowX !== 'visible') {
            const ar = a.getBoundingClientRect();
            if (centerX < ar.x || centerX > ar.x + ar.width) return false;
          }
        }
        return true;
      };
      const visible = [...document.querySelectorAll(${JSON.stringify(selector)})].filter(
        horizontallyVisible,
      );
      const el = visible[${options.index ?? 0}];
      if (!el) return '';
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      const x = Math.floor(r.x + r.width / 2);
      const y = ${options.atBottom ? 'Math.floor(r.bottom) - 3' : 'Math.floor(r.y) + 8'};
      const hit = document.elementFromPoint(x, y);
      if (!hit || !(el === hit || el.contains(hit) || hit.contains(el))) return '';
      return JSON.stringify({ x, y });
    })()`);
    return JSON.parse(point) as { x: number; y: number };
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
    await this.eval(`(async () => {
      const target = document.querySelector(${JSON.stringify(selector)});
      if (!target) throw new Error('wheelBurst: no element for selector');
      const rect = target.getBoundingClientRect();
      for (let index = 0; index < ${options.count}; index += 1) {
        target.dispatchEvent(new WheelEvent('wheel', {
          bubbles: true,
          cancelable: true,
          clientX: Math.floor(rect.x + rect.width / 2),
          clientY: Math.floor(rect.y + rect.height / 2),
          deltaX: ${options.deltaX},
          deltaY: ${options.deltaY ?? 0},
        }));
        await new Promise((resolve) => setTimeout(resolve, ${options.gapMs ?? 20}));
      }
    })()`);
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

  /** Focuses the element and types text into it (React-compatible). */
  async type(selector: string, text: string): Promise<void> {
    await this.eval(`document.querySelector(${JSON.stringify(selector)})?.focus()`);
    await this.send('Input.insertText', { text });
  }

  async clickButtonWithText(text: string): Promise<void> {
    await this.waitFor<boolean>(
      `[...document.querySelectorAll('button')].some(b => b.textContent?.trim() === ${JSON.stringify(text)})`,
    );
    await this.eval(
      `[...document.querySelectorAll('button')].find(b => b.textContent?.trim() === ${JSON.stringify(text)})?.click()`,
    );
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

export interface App {
  readonly cdp: Cdp;
  readonly dump: (label: string) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly userDataDir: string;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

export interface LaunchOptions {
  /**
   * 'off' (default): no calendar bridge. 'real': the helper. A fixture: the
   * in-memory EventKit — Apple events live nowhere else, so this is how e2e
   * sees them without reading a developer's calendars.
   */
  readonly appleCalendar?: 'off' | 'real' | { readonly fixture: AppleCalendarFixture };
  /**
   * 'off' (default): no bridge at all. 'real': the helper. A fixture: the
   * in-memory fake client seeded with these rows — the only way e2e sees
   * device contacts or birthdays without touching a developer's address book.
   */
  readonly contacts?: 'off' | 'real' | { readonly fixture: ContactsFixture };
  /**
   * 'off' (default): no MapKit, so no suggestions and no map. 'real': the
   * helper (network-dependent). A fixture: the in-memory geo client with
   * these places and a constant map image — deterministic and offline.
   */
  readonly geo?: 'off' | 'real' | { readonly fixture: GeoFixture };
  /**
   * Absent (default): the real Google clients — a seeded account has no
   * token, so its writes stay queued. A fixture runs the in-process fake
   * Google API with a token for every fixture account: lists and tasks
   * arrive through the first sync and queued writes push, so e2e can
   * watch a temp `local-…` id become a server id.
   */
  readonly google?: { readonly fixture: GoogleFixture };
  /**
   * 'off' (default): no EventKit. 'real': the helper. A fixture uses the
   * in-memory Reminders client so mutation e2e tests never touch personal data.
   */
  readonly reminders?: 'off' | 'real' | { readonly fixture: RemindersFixture };
}

export const launchApp = async (seed?: SeedData, options: LaunchOptions = {}): Promise<App> => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'calendar-e2e-'));
  if (seed) {
    await seedDatabase(userDataDir, seed);
  }
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

  const googleEnv: Record<string, string> = options.google
    ? (() => {
        const fixturePath = join(userDataDir, 'google-fixture.json');
        writeFileSync(fixturePath, JSON.stringify(options.google.fixture));
        return { CALENDAR_GOOGLE: 'fixture', CALENDAR_GOOGLE_FIXTURE: fixturePath };
      })()
    : {};

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

  const electronPath = require('electron') as unknown as string;
  const appDir = join(import.meta.dirname, '..');
  const port = 9333 + Math.floor(Math.random() * 500);
  const child: ChildProcess = spawn(electronPath, [appDir, `--remote-debugging-port=${port}`], {
    env: {
      ...process.env,
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
      // A seeded birthday with reminders on must never post a real banner.
      CALENDAR_NOTIFICATIONS: 'off',
      CALENDAR_USERDATA: userDataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
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

  let cdp: Cdp;
  try {
    cdp = await Cdp.connect(port);
    // Wait for the calendar shell to render.
    await cdp.waitFor(`document.body.textContent.includes('Today')`);
  } catch (error) {
    // A launch failure happens in beforeAll, where no test dump runs:
    // the app's own output is the only clue, so put it in the run log.
    console.error('[e2e app] launch failed; app output follows\n', appLog.join('').slice(-4000));
    child.kill();
    throw error;
  }

  return {
    cdp,
    /** Screenshot + DOM + app log, for CI to upload when a test fails. */
    dump: async (label: string) => {
      const dir = join(import.meta.dirname, '..', 'e2e-artifacts');
      mkdirSync(dir, { recursive: true });
      const safe = label.replaceAll(/[^a-z0-9]+/gi, '-').slice(0, 80);
      writeFileSync(join(dir, `${safe}.log`), appLog.join(''));
      try {
        const html = await cdp.eval<string>('document.body.outerHTML');
        writeFileSync(join(dir, `${safe}.html`), html);
        const shot = (await cdp.send('Page.captureScreenshot')) as { data?: string };
        if (shot.data) {
          writeFileSync(join(dir, `${safe}.png`), Buffer.from(shot.data, 'base64'));
        }
      } catch (error) {
        // A dead renderer is exactly when the log above matters most — record
        // why the richer artifacts couldn't be captured instead of hiding it.
        writeFileSync(join(dir, `${safe}.dump-error.txt`), String(error));
      }
    },
    stop: async () => {
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
  };
};
