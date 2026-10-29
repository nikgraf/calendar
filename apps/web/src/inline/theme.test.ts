import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vite-plus/test';
import script from './theme.js?raw';

type Listener = (event: Record<string, unknown>) => void;

/**
 * Runs the real inline script against stand-ins for the browser: the
 * document's root, the footer's three buttons, one dark <source>, a
 * color-scheme media query, storage (or storage that throws) and a user agent.
 */
const run = ({
  hint = '',
  osDark = false,
  storage = 'ok',
  touch = 0,
  ua = '',
}: {
  hint?: string;
  osDark?: boolean;
  storage?: 'blocked' | 'ok';
  touch?: number;
  ua?: string;
} = {}) => {
  const listeners: Record<string, Listener> = {};
  const root = { dataset: {} as Record<string, string> };
  const buttons = ['auto', 'light', 'dark'].map((value) => ({
    attributes: {} as Record<string, string>,
    closest() {
      return this;
    },
    dataset: { setTheme: value },
    setAttribute(name: string, next: string) {
      this.attributes[name] = next;
    },
  }));
  const source = { dataset: { themeSource: 'dark' }, media: '' };
  const media = {
    addEventListener: (_: string, listener: Listener) => {
      listeners['media'] = listener;
    },
    matches: osDark,
  };
  const values = new Map<string, string>();
  const localStorage =
    storage === 'ok'
      ? {
          getItem: (key: string) => values.get(key) ?? null,
          removeItem: (key: string) => values.delete(key),
          setItem: (key: string, value: string) => values.set(key, value),
        }
      : {
          getItem: () => {
            throw new Error('blocked');
          },
          removeItem: () => {
            throw new Error('blocked');
          },
          setItem: () => {
            throw new Error('blocked');
          },
        };
  runInNewContext(script, {
    document: {
      addEventListener: (type: string, listener: Listener) => {
        listeners[type] = listener;
      },
      documentElement: root,
      querySelectorAll: (selector: string) =>
        selector === '[data-set-theme]' ? buttons : [source],
    },
    localStorage,
    matchMedia: () => media,
    navigator: { maxTouchPoints: touch, userAgent: ua, userAgentData: { platform: hint } },
    window: {
      addEventListener: (type: string, listener: Listener) => {
        listeners[type] = listener;
      },
    },
  });
  const click = (value: 'auto' | 'dark' | 'light') => {
    listeners['click']?.({ target: buttons.find((button) => button.dataset.setTheme === value) });
  };
  const pressed = () =>
    buttons
      .filter((button) => button.attributes['aria-pressed'] === 'true')
      .map((b) => b.dataset.setTheme);
  return { click, listeners, media, pressed, root, source, values };
};

const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15';

describe('platform', () => {
  it.each([
    ['macOS', MAC_UA, 0, 'mac'],
    ['', MAC_UA, 0, 'mac'],
    ['', 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X)', 5, 'ios'],
    // iPadOS asks for the desktop site with a Mac user agent.
    ['', MAC_UA, 5, 'ios'],
    ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0, 'windows'],
    ['', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 0, 'windows'],
    ['Linux', 'Mozilla/5.0 (X11; Linux x86_64)', 0, 'linux'],
    ['Chrome OS', 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)', 0, 'linux'],
    ['Chromium OS', 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)', 0, 'linux'],
    ['', 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0)', 0, 'linux'],
    ['Android', 'Mozilla/5.0 (Linux; Android 16; Pixel 10)', 5, 'android'],
    ['', 'Mozilla/5.0 (Linux; Android 16; Pixel 10)', 5, 'android'],
    ['', 'SomeBot/1.0', 0, 'mac'],
  ])('reads %j / %j (touch %d) as %s', (hint, ua, touch, expected) => {
    expect(run({ hint, touch, ua }).root.dataset['platform']).toBe(expected);
  });
});

describe('color scheme', () => {
  it('follows the OS on Auto and keeps the dark picture on the OS query', () => {
    const page = run({ osDark: true });
    expect(page.root.dataset['theme']).toBe('dark');
    expect(page.root.dataset['themeChoice']).toBe('auto');
    expect(page.source.media).toBe('(prefers-color-scheme: dark)');
    expect(page.pressed()).toEqual(['auto']);

    page.media.matches = false;
    page.listeners['media']?.({});
    expect(page.root.dataset['theme']).toBe('light');
  });

  it('lets a choice in the footer win over the OS, remembered for the next visit', () => {
    const page = run({ osDark: true });
    page.click('light');
    expect(page.root.dataset['theme']).toBe('light');
    expect(page.source.media).toBe('not all');
    expect(page.pressed()).toEqual(['light']);
    expect(page.values.get('solunivo-theme')).toBe('light');

    page.click('dark');
    expect(page.source.media).toBe('all');

    page.click('auto');
    expect(page.values.has('solunivo-theme')).toBe(false);
    expect(page.source.media).toBe('(prefers-color-scheme: dark)');
  });

  it('still switches when storage throws', () => {
    const page = run({ storage: 'blocked' });
    page.click('dark');
    expect(page.root.dataset['theme']).toBe('dark');
    expect(page.pressed()).toEqual(['dark']);
  });

  it('picks up a choice made in another tab', () => {
    const page = run();
    page.values.set('solunivo-theme', 'dark');
    page.listeners['storage']?.({ key: 'solunivo-theme' });
    expect(page.root.dataset['theme']).toBe('dark');
    expect(page.pressed()).toEqual(['dark']);
  });
});
