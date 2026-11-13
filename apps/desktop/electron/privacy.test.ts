import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vite-plus/test';

// One window, recording what content protection it was told last.
const window = {
  protected: null as boolean | null,
  setContentProtection: (value: boolean) => {
    window.protected = value;
  },
  webContents: { send: () => {} },
};
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [window] },
  ipcMain: { handle: () => {} },
}));

/** The module on a fresh launch over `dir` (a new profile unless one is passed). */
const launch = async (dir = mkdtempSync(join(tmpdir(), 'solunivo-privacy-'))) => {
  vi.resetModules();
  window.protected = null;
  const privacy = await import('./privacy.ts');
  privacy.initPrivacy(dir);
  const stored = () =>
    (JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<string, unknown>)[
      'screenPrivacy'
    ];
  return { dir, privacy, stored };
};

describe('screen-sharing privacy', () => {
  it('is off on a new profile: windows show up in captures', async () => {
    const { privacy } = await launch();
    expect(privacy.getPrivacyState()).toEqual({ mode: 'visible' });
    privacy.registerPrivacyWindow(window as never);
    expect(window.protected).toBe(false);
  });

  it('turned on, it protects the windows and stays on after a restart', async () => {
    const first = await launch();
    first.privacy.setPrivacyChoice('hidden');
    expect(window.protected).toBe(true);
    expect(first.stored()).toBe('hidden');

    const { privacy } = await launch(first.dir);
    expect(privacy.getPrivacyState()).toEqual({ mode: 'hidden' });
    expect(privacy.isProtected()).toBe(true);
  });

  it('a pause shows the windows until a restart, which comes back hidden', async () => {
    const first = await launch();
    first.privacy.setPrivacyChoice('hidden');
    first.privacy.setPrivacyChoice('pause10m');
    expect(window.protected).toBe(false);
    expect(first.privacy.getPrivacyState().mode).toBe('hidden');
    expect(first.stored()).toBe('hidden');

    const { privacy } = await launch(first.dir);
    expect(privacy.isProtected()).toBe(true);
  });

  it('turned off again, it stays off after a restart', async () => {
    const first = await launch();
    first.privacy.setPrivacyChoice('hidden');
    first.privacy.setPrivacyChoice('visible');
    expect(window.protected).toBe(false);
    expect(first.stored()).toBe('visible');

    const { privacy } = await launch(first.dir);
    expect(privacy.isProtected()).toBe(false);
  });

  it('reads an unreadable settings file as off', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'solunivo-privacy-'));
    writeFileSync(join(dir, 'settings.json'), '{ "screenPrivacy": "hid');
    const { privacy } = await launch(dir);
    expect(privacy.getPrivacyState()).toEqual({ mode: 'visible' });
  });
});
