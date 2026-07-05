import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CalendarInfo, EventRecord, Account } from '@calendar/core';
import { AccountRepo, CalendarRepo, EventRepo, reposLayer, runMigrations } from '@calendar/db';
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

  /** Polls an expression until it is truthy; returns its value. */
  async waitFor<T>(expression: string, timeoutMs = 15_000): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await this.eval<T>(expression);
      if (value) {
        return value;
      }
      if (Date.now() > deadline) {
        throw new Error(`waitFor timed out: ${expression.slice(0, 120)}`);
      }
      await sleep(150);
    }
  }

  /**
   * Center-ish point of the first element matching the selector. Scrolls the
   * element into the middle of its container first — on CI the week grid can
   * land scrolled differently, leaving early-morning blocks under the sticky
   * header where mouse events would hit the header instead.
   */
  async locate(
    selector: string,
    options: { atBottom?: boolean; index?: number } = {},
  ): Promise<{ x: number; y: number }> {
    const point = await this.waitFor<string>(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${options.index ?? 0}];
      if (!el) return '';
      el.scrollIntoView({ block: 'center', inline: 'nearest' });
      const r = el.getBoundingClientRect();
      return JSON.stringify({
        x: Math.floor(r.x + r.width / 2),
        y: ${options.atBottom ? 'Math.floor(r.bottom) - 3' : 'Math.floor(r.y) + 8'},
      });
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
      CALENDAR_USERDATA: userDataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString();
    if (text.includes('bootstrap failed')) {
      console.error('[e2e app]', text);
    }
  });

  const cdp = await Cdp.connect(port);
  // Wait for the calendar shell to render.
  await cdp.waitFor(`document.body.textContent.includes('Today')`);

  return {
    cdp,
    stop: async () => {
      cdp.close();
      child.kill();
      await sleep(300);
      rmSync(userDataDir, { force: true, recursive: true });
    },
    userDataDir,
  };
};
