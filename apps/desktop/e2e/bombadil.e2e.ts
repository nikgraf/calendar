import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Account, CalendarInfo, EventRecord, Temporal } from '@calendar/core';
import { expect, it } from 'vite-plus/test';
import { launchApp, readEvents } from './harness.ts';

interface SavedForm {
  readonly date: string;
  readonly endDate: string;
  readonly endTime: string;
  readonly startTime: string;
  readonly title: string;
}

interface Probe {
  readonly cancelled: number;
  readonly failure: string | null;
  readonly opened: number;
  readonly saved: ReadonlyArray<SavedForm>;
  readonly seedChecked: boolean;
}

const runBombadil = (
  args: ReadonlyArray<string>,
  output: string,
  signal: AbortSignal,
): Promise<void> =>
  new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const child = spawn('pnpm', ['exec', 'bombadil', 'browser', 'test-external', ...args], {
      cwd: join(import.meta.dirname, '..'),
      // pnpm and the package's Node shim spawn the Rust binary. Keep them
      // in their own process group so cancellation stops the whole driver.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const chunks: Array<string> = [];
    child.stdout.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => chunks.push(chunk.toString()));
    const stop = () => {
      if (child.pid && child.exitCode === null) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          // The process group may already have exited.
        }
      }
    };
    const timer = setTimeout(stop, 150_000);
    signal.addEventListener('abort', stop, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', stop);
    };
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code, endedBy) => {
      cleanup();
      const log = chunks.join('');
      writeFileSync(join(output, 'bombadil.log'), log);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`Bombadil exited ${String(code ?? endedBy)}\n${log.slice(-6000)}`));
      }
    });
  });

it.runIf(process.env['BOMBADIL'] === '1')(
  'Bombadil: cancelled changes stay unsaved and each burst of Save creates one event',
  { retry: 0, timeout: 180_000 },
  async ({ signal }) => {
    const today = Temporal.Now.plainDateISO('UTC');
    const at = (date: string, time: string) =>
      Temporal.PlainDate.from(date).toZonedDateTime({ plainTime: time, timeZone: 'UTC' })
        .epochMilliseconds;
    const dates = [
      today.toString(),
      today.add({ days: 1 }).toString(),
      today.add({ months: 1 }).toString(),
    ];
    const original = new EventRecord({
      accountId: 'acc-bombadil',
      calendarId: 'cal-bombadil',
      endUtc: at(dates[0]!, '11:00'),
      etag: '"seed"',
      id: 'bombadil-seed',
      isAllDay: false,
      startTimeZone: 'UTC',
      startUtc: at(dates[0]!, '10:00'),
      status: 'confirmed',
      syncedAt: 1,
      syncStatus: 'synced',
      title: 'Bombadil original event',
      updatedAt: 1,
    });
    const app = await launchApp(
      {
        accounts: [
          new Account({
            contactsEnabled: false,
            createdAt: 1,
            email: 'bombadil@example.com',
            id: 'acc-bombadil',
            provider: 'google',
            status: 'ok',
            tasksEnabled: false,
          }),
        ],
        calendars: [
          new CalendarInfo({
            accessRole: 'owner',
            accountId: 'acc-bombadil',
            colorHex: '#3b82f6',
            id: 'cal-bombadil',
            isPrimary: true,
            isVisible: true,
            provider: 'google',
            summary: 'Bombadil calendar',
            timeZone: 'UTC',
          }),
        ],
        deviceSettings: { timeZones: { primary: 'UTC', zones: ['device', 'UTC'] } },
        events: [original],
      },
      { model: 'fixture' },
    );
    const output = join(import.meta.dirname, '..', 'e2e-artifacts', `bombadil-${Date.now()}`);
    mkdirSync(output, { recursive: true });
    try {
      await app.cdp.showRail();
      await app.cdp.evaluate((_, choices: ReadonlyArray<string>) => {
        document.body.dataset['bombadilDates'] = JSON.stringify(choices);
      }, dates);
      const origin = await app.cdp.evaluate(() => window.location.href);
      const reproduce = process.env['BOMBADIL_REPRODUCE'];
      await runBombadil(
        [
          '--remote-debugger',
          app.remoteDebugger,
          '--output-path',
          output,
          ...(reproduce
            ? ['--reproduce', resolve(reproduce)]
            : ['--time-limit', '45s', '--exit-on-violation']),
          origin,
          join(import.meta.dirname, 'bombadil', 'editor.ts'),
        ],
        output,
        signal,
      );
      await app.cdp.waitUntil(() => document.body.dataset['bombadilBusy'] !== 'true');
      const probe = JSON.parse(
        await app.cdp.evaluate(() => document.body.dataset['bombadilProbe'] ?? '{}'),
      ) as Probe;
      writeFileSync(join(output, 'editor-probe.json'), JSON.stringify(probe, null, 2));
      expect(probe.failure).toBeNull();
      expect(probe.seedChecked).toBe(true);
      expect(probe.cancelled).toBeGreaterThan(0);
      expect(probe.saved.length).toBeGreaterThan(0);
      // Persistence is the oracle, including events moved outside the visible
      // week. DOM counts alone would miss these and cancelled draft writes.
      const persisted = await readEvents(app.userDataDir);
      expect(persisted).toHaveLength(probe.saved.length + 1);
      const seed = persisted.find((event) => event.id === original.id)!;
      expect({ endUtc: seed.endUtc, startUtc: seed.startUtc, title: seed.title }).toEqual({
        endUtc: original.endUtc,
        startUtc: original.startUtc,
        title: original.title,
      });
      for (const saved of probe.saved) {
        const matches = persisted.filter((event) => event.title === saved.title);
        expect(matches).toHaveLength(1);
        expect(matches[0]).toMatchObject({
          endUtc: at(saved.endDate, saved.endTime),
          isAllDay: false,
          startUtc: at(saved.date, saved.startTime),
        });
      }
    } catch (error) {
      await app.dump('bombadil-editor');
      throw error;
    } finally {
      await app.stop();
    }
  },
);
