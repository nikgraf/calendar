import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test';

// One window, recording what content protection it was told last.
const window = {
  protected: null as boolean | null,
  setContentProtection: (value: boolean) => {
    window.protected = value;
  },
  webContents: { send: () => {} },
};
// The Mac waking from sleep ('resume') or the screen unlocking.
const powerMonitor = new EventEmitter();
vi.mock('electron', () => ({
  app: { whenReady: () => Promise.resolve() },
  BrowserWindow: { getAllWindows: () => [window] },
  ipcMain: { handle: () => {} },
  powerMonitor,
}));

const MINUTE = 60 * 1000;

const profiles: Array<string> = [];
const newProfile = () => {
  const dir = mkdtempSync(join(tmpdir(), 'solunivo-privacy-'));
  profiles.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of profiles.splice(0)) {
    rmSync(dir, { force: true, recursive: true });
  }
});

/** The module on a fresh launch over `dir` (a new profile unless one is passed). */
const launch = async (dir = newProfile()) => {
  vi.resetModules();
  window.protected = null;
  // The last launch's module stops hearing wake and unlock.
  powerMonitor.removeAllListeners();
  const privacy = await import('./privacy.ts');
  privacy.initPrivacy(dir);
  // It listens for wake and unlock once the app is ready.
  await Promise.resolve();
  const stored = () =>
    (JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as Record<string, unknown>)[
      'screenPrivacy'
    ];
  return { dir, privacy, stored };
};

/** A launch with privacy on and the 10-minute pause just started. */
const paused = async () => {
  const { privacy } = await launch();
  privacy.setPrivacyChoice('hidden');
  privacy.setPrivacyChoice('pause10m');
  expect(window.protected).toBe(false);
  return privacy;
};

// Asleep, both clocks run on (Electron's performance.now() reads libuv's
// mach_continuous_time) while the main loop's timers hold. The fake
// clock's setSystemTime moves Date only, so the sleep tests add the slept
// time to performance.now() themselves.
let slept = 0;
const sleep = (ms: number) => {
  vi.setSystemTime(Date.now() + ms);
  slept += ms;
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
    // The first launch's 10-minute timer goes with its pause.
    first.privacy.setPrivacyChoice('hidden');
  });

  it('a pause while visible changes nothing: no countdown, nothing stored', async () => {
    const { dir, privacy } = await launch();
    expect(privacy.setPrivacyChoice('pause10m')).toEqual({ mode: 'visible' });
    expect(privacy.getPrivacyState()).toEqual({ mode: 'visible' });
    expect(window.protected).toBeNull();
    expect(existsSync(join(dir, 'settings.json'))).toBe(false);
  });

  it('Visible during a pause ends it, timer and all', async () => {
    vi.useFakeTimers();
    try {
      const { privacy, stored } = await launch();
      privacy.setPrivacyChoice('hidden');
      privacy.setPrivacyChoice('pause10m');
      expect(vi.getTimerCount()).toBe(1);
      expect(privacy.setPrivacyChoice('visible')).toEqual({ mode: 'visible' });
      expect(vi.getTimerCount()).toBe(0);
      expect(window.protected).toBe(false);
      expect(stored()).toBe('visible');
    } finally {
      vi.useRealTimers();
    }
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
    const dir = newProfile();
    writeFileSync(join(dir, 'settings.json'), '{ "screenPrivacy": "hid');
    const { privacy } = await launch(dir);
    expect(privacy.getPrivacyState()).toEqual({ mode: 'visible' });
  });
});

describe('a pause the Mac sleeps through', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    slept = 0;
    const fakeNow = performance.now.bind(performance);
    vi.spyOn(performance, 'now').mockImplementation(() => fakeNow() + slept);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each(['resume', 'unlock-screen'])(
    'slept past its end, the windows hide again on %s',
    async (event) => {
      const privacy = await paused();
      vi.advanceTimersByTime(2 * MINUTE);
      sleep(30 * MINUTE);
      powerMonitor.emit(event);
      expect(window.protected).toBe(true);
      expect(privacy.getPrivacyState()).toEqual({ mode: 'hidden' });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('woken before its end, the windows hide when its ten minutes are up', async () => {
    await paused();
    vi.advanceTimersByTime(2 * MINUTE);
    sleep(5 * MINUTE);
    powerMonitor.emit('resume');
    expect(window.protected).toBe(false);
    vi.advanceTimersByTime(3 * MINUTE - 1);
    expect(window.protected).toBe(false);
    vi.advanceTimersByTime(1);
    expect(window.protected).toBe(true);
  });

  it('should the monotonic clock stop during sleep, the wall clock still ends it', async () => {
    await paused();
    vi.advanceTimersByTime(2 * MINUTE);
    vi.setSystemTime(Date.now() + 30 * MINUTE);
    powerMonitor.emit('resume');
    expect(window.protected).toBe(true);
  });

  it('a clock set back does not stretch it: a wake re-arms for the monotonic remainder', async () => {
    const privacy = await paused();
    vi.advanceTimersByTime(MINUTE);
    vi.setSystemTime(Date.now() - 60 * MINUTE);
    sleep(2 * MINUTE);
    powerMonitor.emit('resume');
    vi.advanceTimersByTime(7 * MINUTE - 1);
    expect(window.protected).toBe(false);
    vi.advanceTimersByTime(1);
    expect(window.protected).toBe(true);
    expect(privacy.getPrivacyState()).toEqual({ mode: 'hidden' });
  });

  it('a clock stepped forward while awake ends it at the next read, for every window', async () => {
    const privacy = await paused();
    vi.advanceTimersByTime(2 * MINUTE);
    vi.setSystemTime(Date.now() + 30 * MINUTE);
    expect(window.protected).toBe(false);
    expect(privacy.isProtected()).toBe(true);
    expect(window.protected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
