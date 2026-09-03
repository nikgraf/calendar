import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Account, CalendarInfo, EventRecord, TaskListInfo, TaskRecord } from '@calendar/core';
import {
  AccountRepo,
  CalendarRepo,
  EventRepo,
  PendingOpRepo,
  reposLayer,
  runMigrations,
  TaskRepo,
} from '@calendar/db';
import { SqliteClient } from '@effect/sql-sqlite-node';
import { Effect, Layer } from 'effect';
import { layer as reactivityLayer } from 'effect/unstable/reactivity/Reactivity';

const require = createRequire(import.meta.url);

/* eslint-disable no-console -- harness diagnostics are wanted in e2e output */

// ---------------------------------------------------------------------------
// Seeding: build the schema with the app's own migrations, insert fixtures.
// Must run BEFORE the app launches (external writes don't invalidate atoms).
// ---------------------------------------------------------------------------

export interface SeedData {
  readonly accounts: ReadonlyArray<Account>;
  readonly calendars: ReadonlyArray<CalendarInfo>;
  readonly events: ReadonlyArray<EventRecord>;
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
      const tasks = yield* TaskRepo;
      yield* tasks.upsertLists(seed.taskLists ?? [], 1);
      yield* tasks.upsertTasks(seed.tasks ?? [], 1);
    }).pipe(Effect.provide(dbLayer)),
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
    const deadline = Date.now() + 15_000;
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

export const launchApp = async (seed?: SeedData): Promise<App> => {
  const userDataDir = mkdtempSync(join(tmpdir(), 'calendar-e2e-'));
  if (seed) {
    await seedDatabase(userDataDir, seed);
  }

  const electronPath = require('electron') as unknown as string;
  const appDir = join(import.meta.dirname, '..');
  const port = 9333 + Math.floor(Math.random() * 500);
  const child: ChildProcess = spawn(electronPath, [appDir, `--remote-debugging-port=${port}`], {
    env: {
      ...process.env,
      // Seeded Apple rows must not be replaced by (or prompt for) the
      // developer's real Reminders — see remindersClient.ts.
      CALENDAR_REMINDERS: 'off',
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

  const cdp = await Cdp.connect(port);
  // Wait for the calendar shell to render.
  await cdp.waitFor(`document.body.textContent.includes('Today')`);

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
