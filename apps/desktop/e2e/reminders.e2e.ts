import { Account, APPLE_REMINDERS_ACCOUNT_ID, TaskListInfo, TaskRecord } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type App, launchApp } from './harness.ts';

// Seeded straight into SQLite: the harness launches the app with
// CALENDAR_REMINDERS=off, so no EventKit sync can replace these rows and
// no TCC prompt can fire on a developer's Mac. This covers the UI half of
// the Reminders integration — chips, the provider-specific form, the
// sidebar section — without a real Reminders database.
const today = new Date();
const isoToday = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;

const seed = {
  accounts: [
    new Account({
      createdAt: 1,
      displayName: 'Apple Reminders',
      email: '',
      id: APPLE_REMINDERS_ACCOUNT_ID,
      provider: 'apple',
      status: 'ok',
      tasksEnabled: true,
    }),
  ],
  calendars: [],
  events: [],
  taskLists: [
    new TaskListInfo({
      accountId: APPLE_REMINDERS_ACCOUNT_ID,
      colorHex: '#ff0000',
      id: 'ek-list-1',
      isVisible: true,
      provider: 'apple',
      title: 'Reminders',
    }),
  ],
  tasks: [
    new TaskRecord({
      accountId: APPLE_REMINDERS_ACCOUNT_ID,
      alarms: [-15],
      dueDate: isoToday,
      dueTime: '14:00',
      id: 'ek-rem-1',
      listId: 'ek-list-1',
      priority: 'high',
      provider: 'apple',
      status: 'needsAction',
      title: 'Call mom',
      updatedAt: 1,
    }),
  ],
};

describe('Apple Reminders UI', () => {
  let app: App;
  beforeAll(async () => {
    app = await launchApp(seed);
  }, 60_000);
  afterAll(async () => {
    await app.stop();
  });

  it('renders a timed, prioritised reminder chip and lists the Apple account', async () => {
    const { cdp } = app;
    const chip = await cdp.locate('[title="Call mom"]');
    expect(chip).toBeTruthy();
    const label = await cdp.waitFor<string>(
      `document.querySelector('[title="Call mom"]')?.textContent ?? ''`,
    );
    // Time first, then the Reminders-app priority marker, then the title.
    expect(label).toContain('14:00 !!! Call mom');
    const sidebar = await cdp.waitFor<string>('document.body.textContent ?? ""');
    expect(sidebar).toContain('Apple Reminders');
  });

  it('opens the Reminders form (time, priority, movable list) instead of the Google one', async () => {
    const { cdp } = app;
    const chip = await cdp.locate('[title="Call mom"]');
    // Skip the leading checkbox, like the task-editor test does.
    await cdp.click(chip.x + 40, chip.y);
    try {
      await cdp.waitFor(`document.body.textContent.includes('Edit reminder')`);
      const facts = await cdp.waitFor<string>(`JSON.stringify({
        listEnabled: !document.querySelector('select[aria-label="Reminders list"]')?.disabled,
        priorityHigh: document.querySelector('[role="radio"][aria-checked="true"]')?.textContent,
        timeValue: document.querySelector('input[aria-label="Due time"]')?.value,
        timed: document.querySelector('input[aria-label="At a time"]')?.checked,
      })`);
      expect(JSON.parse(facts)).toEqual({
        listEnabled: true,
        priorityHigh: 'High',
        timed: true,
        timeValue: '14:00',
      });
    } finally {
      await cdp.clickButtonWithText('Cancel');
    }
  });
});
