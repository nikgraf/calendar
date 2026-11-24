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

  it('is on from the start, offers the download, and deletes the files keeping the switch as it was', async () => {
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
      'Download Speech Model (712 MB)',
    );

    await settings.clickTestId('parakeet-action');
    await settings.waitUntil(
      ($) => $.text('[data-testid="parakeet-status"]') === 'On this Mac · 712 MB',
    );
    expect(await settings.evaluate(($) => $.has('[data-testid="parakeet-action"]'))).toBe(false);

    // Off: the files stay.
    await settings.clickTestId('read-with-parakeet');
    await settings.waitUntil(
      ($) => !$.el<HTMLInputElement>('[data-testid="read-with-parakeet"]')!.checked,
    );
    expect(await settings.evaluate(($) => $.text('[data-testid="parakeet-status"]'))).toBe(
      'On this Mac · 712 MB',
    );

    // Deleted while off: the download is offered again, and the switch stays off.
    await settings.clickTestId('parakeet-delete');
    await settings.waitUntil(
      ($) => $.text('[data-testid="parakeet-action"]') === 'Download Speech Model (712 MB)',
    );
    expect(
      await settings.evaluate(
        ($) => $.el<HTMLInputElement>('[data-testid="read-with-parakeet"]')!.checked,
      ),
    ).toBe(false);
  });
});

describe('Settings › AI Model explains the Assistant', () => {
  let app: App;

  beforeAll(async () => {
    app = await launchApp(seed, { parakeet: 'fixture' });
  });

  afterAll(async () => {
    await app?.stop();
  });

  it('says it runs on this Mac only, shows the steps, and downloads the speech model from its row', async () => {
    const settings = await app.openSettings('model');
    await settings.waitUntil(($) => $.has('[data-testid="assistant-model-section"]'));
    expect(await settings.evaluate(($) => $.text('[data-testid="assistant-promise"]'))).toBe(
      'The Assistant uses only models on this Mac. What you say or type never leaves it.',
    );
    expect(
      await settings.evaluate(($) => $.all('[data-testid^="assistant-flow-step-"]').length),
    ).toBe(4);
    expect(
      await settings.evaluate(($) => $.text('[data-testid="assistant-model-speech-status"]')),
    ).toBe('Not on this Mac yet.');

    await settings.clickTestId('assistant-model-speech-action');
    await settings.waitUntil(
      ($) => $.text('[data-testid="assistant-model-speech-status"]') === 'On this Mac · 712 MB',
    );
    expect(
      await settings.evaluate(($) => $.has('[data-testid="assistant-model-speech-action"]')),
    ).toBe(false);
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

  it('offers both models in one button, explains the flow, and the phrases model alone switches Parakeet off', async () => {
    const { cdp } = app;
    await cdp.clickTestId('getting-started-row-create');
    await cdp.waitUntil(($) => $.el('[data-testid="lesson-banner"]')?.dataset.lesson === 'create');
    await cdp.waitUntil(($) => $.text('[data-testid="lesson-model-action"]') === 'Download Models');
    expect(await cdp.evaluate(($) => $.text('[data-testid="lesson-banner-note"]'))).toBe(
      'The Assistant uses only models on this Mac. What you say or type never leaves it. It needs two models, a one-time download of 1.5 GB. Until then, try the demo below.',
    );
    expect(await cdp.evaluate(($) => $.text('[data-testid="lesson-model-decline"]'))).toBe(
      'Download Only Phrases Model',
    );

    // How it works: closed until asked, then the four steps.
    expect(await cdp.evaluate(($) => $.has('[data-testid="lesson-explain"]'))).toBe(false);
    await cdp.clickTestId('lesson-explain-toggle');
    await cdp.waitUntil(($) => $.has('[data-testid="lesson-explain"]'));
    expect(
      await cdp.evaluate(
        ($) => $.all('[data-testid="lesson-explain"] [data-testid^="assistant-flow-step-"]').length,
      ),
    ).toBe(4);

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
