import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSessions } from '@calendar/ai';
import { Account, CalendarInfo } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp, readEvents } from './harness.ts';

// Keep Assistant Sessions (Settings › AI Model): off at first, so a thread
// keeps nothing; switched on, a thread said to the Assistant and saved is
// kept, counted in Settings, exported (to CALENDAR_SESSIONS_EXPORT: no
// save dialog under CDP) and deleted. The fixture model reads the phrase
// (`Title | +N | HH:MM-HH:MM`), so nothing depends on a real model or day.
const seed = {
  accounts: [
    new Account({
      contactsEnabled: false,
      createdAt: 1,
      email: 'e2e@example.com',
      id: 'acc-e2e',
      provider: 'google',
      status: 'ok',
      tasksEnabled: false,
    }),
  ],
  calendars: [
    new CalendarInfo({
      accessRole: 'owner',
      accountId: 'acc-e2e',
      colorHex: '#3b82f6',
      id: 'cal-e2e',
      isPrimary: true,
      isVisible: true,
      provider: 'google',
      summary: 'Work',
      timeZone: 'Europe/Vienna',
    }),
  ],
  events: [],
};

// CDP key events don't carry macOS meta reliably: dispatch ⌘N to the app's own window listener.
const commandN = () => {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', metaKey: true }));
};

const COUNT = '[data-testid="assistant-sessions-count"]';

describe('Keep Assistant Sessions', () => {
  let app: App;
  const out = mkdtempSync(join(tmpdir(), 'calendar-e2e-sessions-'));
  const exported = join(out, 'export.jsonl');
  beforeAll(async () => {
    app = await launchApp(seed, {
      env: { CALENDAR_SESSIONS_EXPORT: exported },
      model: 'fixture',
    });
  }, 60_000);
  afterAll(async () => {
    await app?.stop();
    rmSync(out, { force: true, recursive: true });
  });

  /** A phrase to a new event's Assistant, saved: the editor closes, and its thread is done. */
  const saveDinner = async (title: string) => {
    const { cdp } = app;
    await cdp.evaluate(commandN);
    await cdp.waitUntil(($) => $.text('[data-testid="editor-title"]') === 'New event');
    await cdp.say(`${title} | +2 | 19:00-20:00`);
    await cdp.waitUntil(
      ($, said: string) => $.text('[data-testid="assistant-card-title"]') === said,
      title,
    );
    await cdp.clickButtonWithText('Save');
    await cdp.waitUntil(($) => !$.has('[data-testid="editor"]'));
    await expect
      .poll(async () => (await readEvents(app.userDataDir)).some((event) => event.title === title))
      .toBe(true);
  };

  it('keeps nothing while off, then keeps, exports and deletes a saved thread', async () => {
    const settings = await app.openSettings('model');
    await settings.waitUntil(($) => $.has('[data-testid="assistant-sessions"]'));
    await settings.waitUntil(
      ($) => $.text('[data-testid="assistant-sessions-count"]') === 'No sessions kept',
    );
    expect(
      await settings.evaluate(
        ($) => $.el<HTMLInputElement>('[data-testid="keep-assistant-sessions"]')!.checked,
      ),
    ).toBe(false);

    // Off: a thread leaves nothing behind.
    await saveDinner('Before');
    expect(existsSync(join(app.userDataDir, 'assistant-sessions.jsonl'))).toBe(false);

    await settings.clickTestId('keep-assistant-sessions');
    await settings.waitUntil(
      ($) => $.el<HTMLInputElement>('[data-testid="keep-assistant-sessions"]')!.checked,
    );
    await saveDinner('Dinner');
    await settings.waitUntil(($, count: string) => $.text(count) === '1 session kept', COUNT);

    await settings.clickTestId('assistant-sessions-export');
    await settings.waitUntil(($) => $.has('[data-testid="assistant-sessions-notice"]'));
    const { sessions, skipped } = parseSessions(readFileSync(exported, 'utf8'));
    expect(skipped).toBe(0);
    expect(sessions).toHaveLength(1);
    const [session] = sessions;
    expect(session).toMatchObject({
      app: { platform: 'Mac' },
      left: 0,
      model: 'fixture',
      origin: 'new',
      saved: [{ edited: [], endTime: '20:00', kind: 'event', startTime: '19:00', title: 'Dinner' }],
    });
    expect(session?.app.version).not.toBe('');
    expect(session?.turns).toMatchObject([
      {
        input: 'typed',
        outcome: { kind: 'changed' },
        route: 'first',
        text: 'Dinner | +2 | 19:00-20:00',
      },
    ]);
    expect(session?.turns[0]?.reads[0]?.prompt).toContain('Phrase: Dinner | +2 | 19:00-20:00');
    expect(session?.turns[0]?.reads[0]?.result).toMatchObject({ kind: 'parsed' });

    // Delete All asks first, then the log is gone.
    await settings.clickTestId('assistant-sessions-delete');
    await settings.waitUntil(($) => $.has('[data-testid="assistant-sessions-confirm"]'));
    await settings.clickTestId('assistant-sessions-delete-yes');
    await settings.waitUntil(($, count: string) => $.text(count) === 'No sessions kept', COUNT);
    expect(existsSync(join(app.userDataDir, 'assistant-sessions.jsonl'))).toBe(false);
  });
});
