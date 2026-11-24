import { Account, CalendarInfo } from '@calendar/core';
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test';
import { type App, launchApp } from './harness.ts';

/**
 * Parakeet on the Mac under `parakeet: 'fixture'` (CALENDAR_PARAKEET=fixture):
 * its state in main's memory, a download that is done at once and nothing
 * loaded. What dictation reads with it is the helper's (ParakeetBridge.swift);
 * here, what Settings › Dictation and the Create lesson offer and do.
 */

/** An account already there: no setup, the Getting started card at once. */
const seed = {
  accounts: [
    new Account({
      contactsEnabled: false,
      createdAt: 1,
      email: 'parakeet@example.com',
      id: 'acc-parakeet',
      provider: 'google',
      status: 'ok',
      tasksEnabled: false,
    }),
  ],
  calendars: [
    new CalendarInfo({
      accessRole: 'owner',
      accountId: 'acc-parakeet',
      colorHex: '#16a34a',
      id: 'cal-parakeet',
      isPrimary: true,
      isVisible: true,
      provider: 'google',
      summary: 'Personal',
      timeZone: 'Europe/Vienna',
    }),
  ],
  events: [],
};

/** The Assistant's model not asked for yet; its host refuses once it is. */
const manifest = JSON.stringify({
  bytes: 10,
  file: 'e2e.gguf',
  sha256: '0'.repeat(64),
  url: 'http://127.0.0.1:9/e2e.gguf',
  version: 'e2e-1',
});

describe('Settings › Dictation › Read With Parakeet', () => {
  let app: App;

  beforeAll(async () => {
    app = await launchApp(seed, { parakeet: 'fixture' });
  });

  afterAll(async () => {
    await app?.stop();
  });

  it('is on from the start, offers the download, and deletes the files keeping the switch', async () => {
    const settings = await app.openSettings('dictation');
    await settings.waitUntil(($) => $.has('[data-testid="dictation-parakeet"]'));
    expect(
      await settings.evaluate(
        ($) => $.el<HTMLInputElement>('[data-testid="read-with-parakeet"]')!.checked,
      ),
    ).toBe(true);
    expect(await settings.evaluate(($) => $.text('[data-testid="parakeet-status"]'))).toBe(
      'Not on this Mac yet. It is a one-time download.',
    );
    expect(await settings.evaluate(($) => $.text('[data-testid="parakeet-action"]'))).toBe(
      'Download Parakeet (712 MB)',
    );

    await settings.clickTestId('parakeet-action');
    await settings.waitUntil(
      ($) => $.text('[data-testid="parakeet-status"]') === 'On this Mac · 712 MB',
    );
    expect(await settings.evaluate(($) => $.has('[data-testid="parakeet-action"]'))).toBe(false);

    // Off: the files stay; on again, it reads with them at once.
    await settings.clickTestId('read-with-parakeet');
    await settings.waitUntil(
      ($) => !$.el<HTMLInputElement>('[data-testid="read-with-parakeet"]')!.checked,
    );
    expect(await settings.evaluate(($) => $.text('[data-testid="parakeet-status"]'))).toBe(
      'On this Mac · 712 MB',
    );
    await settings.clickTestId('read-with-parakeet');

    await settings.clickTestId('parakeet-delete');
    await settings.waitUntil(
      ($) => $.text('[data-testid="parakeet-action"]') === 'Download Parakeet (712 MB)',
    );
    expect(
      await settings.evaluate(
        ($) => $.el<HTMLInputElement>('[data-testid="read-with-parakeet"]')!.checked,
      ),
    ).toBe(true);
  });
});

describe('the Create lesson offers Parakeet beside the Assistant’s model', () => {
  let app: App;

  beforeAll(async () => {
    app = await launchApp(seed, {
      // A stand-in for llama-server, which CI's build has none of: never
      // started, since the download fails before there is a model to run.
      assistantModel: { llamaServer: '/usr/bin/true', manifest },
      onboarding: 'on',
      parakeet: 'fixture',
    });
  });

  afterAll(async () => {
    await app?.stop();
  });

  it('offers both in one button, and Without Parakeet fetches the Assistant’s alone and switches Parakeet off', async () => {
    const { cdp } = app;
    await cdp.clickTestId('getting-started-row-create');
    await cdp.waitUntil(($) => $.el('[data-testid="lesson-banner"]')?.dataset.lesson === 'create');
    await cdp.waitUntil(
      ($) => $.text('[data-testid="lesson-model-action"]') === 'Download Both (1.5 GB)',
    );
    expect(await cdp.evaluate(($) => $.text('[data-testid="lesson-banner-note"]'))).toContain(
      'Dictation can also read with Parakeet, a speech model on this Mac',
    );
    expect(await cdp.evaluate(($) => $.text('[data-testid="lesson-model-decline"]'))).toBe(
      'Without Parakeet',
    );

    await cdp.clickTestId('lesson-model-decline');
    // The Assistant's download was asked for (this host refuses it), and
    // Parakeet is no longer offered: it is off.
    await cdp.waitUntil(
      { timeoutMs: 10_000 },
      ($) => $.text('[data-testid="lesson-model-action"]') === 'Try Again',
    );
    expect(await cdp.evaluate(($) => $.has('[data-testid="lesson-model-decline"]'))).toBe(false);
    const settings = await app.openSettings('dictation');
    await settings.waitUntil(
      ($) => $.el<HTMLInputElement>('[data-testid="read-with-parakeet"]')?.checked === false,
    );
  });
});
