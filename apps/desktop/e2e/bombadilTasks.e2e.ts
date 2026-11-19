import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  Account,
  APPLE_REMINDERS_ACCOUNT_ID,
  CalendarInfo,
  TaskListInfo,
  TaskRecord,
  Temporal,
} from '@calendar/core';
import { expect, it } from 'vite-plus/test';
import { runBombadil } from './bombadil/driver.ts';
import { launchApp, readEvents, readTasks } from './harness.ts';

interface Probe {
  readonly cancelled: number;
  readonly failure: string | null;
  readonly saved: ReadonlyArray<{
    readonly date: string;
    readonly kind: 'task' | 'reminder';
    readonly notes: string;
    readonly title: string;
  }>;
  readonly seedsChecked: boolean;
}

it.runIf(process.env['BOMBADIL'] === '1')(
  'Bombadil: task kind switches preserve fields, cancellation persists nothing, and Save bursts create one item',
  { retry: 0, timeout: 180_000 },
  async ({ signal }) => {
    const today = Temporal.Now.plainDateISO('UTC');
    const dates = [
      today.toString(),
      today.add({ days: 1 }).toString(),
      today.add({ months: 1 }).toString(),
    ];
    const googleSeed = new TaskRecord({
      accountId: 'acc-bombadil-tasks',
      dueDate: dates[0],
      id: 'bombadil-google-seed',
      listId: 'list-bombadil',
      notes: 'Original Google notes',
      provider: 'google',
      status: 'needsAction',
      title: 'Original Google task',
      updatedAt: 1,
    });
    const reminderSeed = new TaskRecord({
      accountId: APPLE_REMINDERS_ACCOUNT_ID,
      dueDate: dates[0],
      dueTime: '14:00',
      id: 'bombadil-reminder-seed',
      listId: 'reminders-bombadil',
      notes: 'Original reminder notes',
      provider: 'apple',
      status: 'needsAction',
      title: 'Original reminder',
      updatedAt: 1,
    });
    const app = await launchApp(
      {
        accounts: [
          new Account({
            contactsEnabled: false,
            createdAt: 1,
            email: 'bombadil@example.com',
            id: 'acc-bombadil-tasks',
            provider: 'google',
            status: 'ok',
            tasksEnabled: true,
          }),
          new Account({
            contactsEnabled: false,
            createdAt: 1,
            email: '',
            id: APPLE_REMINDERS_ACCOUNT_ID,
            provider: 'apple',
            status: 'ok',
            tasksEnabled: true,
          }),
        ],
        calendars: [
          new CalendarInfo({
            accessRole: 'owner',
            accountId: 'acc-bombadil-tasks',
            colorHex: '#3b82f6',
            id: 'cal-bombadil-tasks',
            isPrimary: true,
            isVisible: true,
            provider: 'google',
            summary: 'Bombadil calendar',
            timeZone: 'UTC',
          }),
        ],
        deviceSettings: { timeZones: { primary: 'UTC', zones: ['device', 'UTC'] } },
        events: [],
        taskLists: [
          new TaskListInfo({
            accountId: 'acc-bombadil-tasks',
            id: 'list-bombadil',
            isVisible: true,
            provider: 'google',
            title: 'Google Tasks',
          }),
          new TaskListInfo({
            accountId: APPLE_REMINDERS_ACCOUNT_ID,
            id: 'reminders-bombadil',
            isVisible: true,
            provider: 'apple',
            title: 'Reminders',
          }),
        ],
        tasks: [googleSeed, reminderSeed],
      },
      {
        model: 'fixture',
        reminders: {
          fixture: {
            lists: [{ allowsModifications: true, id: 'reminders-bombadil', title: 'Reminders' }],
            reminders: [
              {
                alarms: [],
                completed: false,
                dueDate: dates[0],
                dueTime: '14:00',
                id: reminderSeed.id,
                listId: reminderSeed.listId,
                notes: reminderSeed.notes,
                priority: 0,
                title: reminderSeed.title,
                updatedAt: 1,
              },
            ],
          },
        },
      },
    );
    const output = join(import.meta.dirname, '..', 'e2e-artifacts', `bombadil-tasks-${Date.now()}`);
    mkdirSync(output, { recursive: true });
    try {
      await app.cdp.showRail();
      await app.cdp.evaluate((_, choices: ReadonlyArray<string>) => {
        document.body.dataset['bombadilTaskDates'] = JSON.stringify(choices);
      }, dates);
      const origin = await app.cdp.evaluate(() => window.location.href);
      const reproduce = process.env['BOMBADIL_TASK_REPRODUCE'];
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
          join(import.meta.dirname, 'bombadil', 'taskEditor.ts'),
        ],
        output,
        signal,
      );
      await app.cdp.waitUntil(() => document.body.dataset['bombadilTaskBusy'] !== 'true');
      const probe = JSON.parse(
        await app.cdp.evaluate(() => document.body.dataset['bombadilTaskProbe'] ?? '{}'),
      ) as Probe;
      writeFileSync(join(output, 'task-editor-probe.json'), JSON.stringify(probe, null, 2));
      expect(probe.failure).toBeNull();
      expect(probe.seedsChecked).toBe(true);
      expect(probe.cancelled).toBeGreaterThan(0);
      expect(probe.saved.some((draft) => draft.kind === 'task')).toBe(true);
      expect(probe.saved.some((draft) => draft.kind === 'reminder')).toBe(true);
      const tasks = await readTasks(app.userDataDir);
      expect(tasks).toHaveLength(probe.saved.length + 2);
      for (const seed of [googleSeed, reminderSeed]) {
        expect(tasks.find((task) => task.id === seed.id)).toMatchObject({
          dueDate: seed.dueDate,
          dueTime: seed.dueTime,
          listId: seed.listId,
          notes: seed.notes,
          provider: seed.provider,
          status: 'needsAction',
          title: seed.title,
        });
      }
      for (const saved of probe.saved) {
        const matches = tasks.filter((task) => task.title === saved.title);
        expect(matches).toHaveLength(1);
        expect(matches[0]).toMatchObject({
          accountId: saved.kind === 'task' ? googleSeed.accountId : reminderSeed.accountId,
          dueDate: saved.date,
          dueTime: undefined,
          listId: saved.kind === 'task' ? googleSeed.listId : reminderSeed.listId,
          notes: saved.notes,
          provider: saved.kind === 'task' ? 'google' : 'apple',
          status: 'needsAction',
        });
      }
      // An abandoned Task → Event conversion or an intermediate new-event
      // draft must never leave a persisted event behind.
      expect(await readEvents(app.userDataDir)).toEqual([]);
    } catch (error) {
      await app.dump('bombadil-tasks');
      throw error;
    } finally {
      await app.stop();
    }
  },
);
