import type { ThemeScheme } from '@calendar/core';
import { useSyncExternalStore } from 'react';

// Electron mirrors the OS appearance (nativeTheme) onto this media query,
// so no IPC is needed: the renderer reads it like any web page would.
const query = () => window.matchMedia('(prefers-color-scheme: dark)');

export const readScheme = (): ThemeScheme => (query().matches ? 'dark' : 'light');

const subscribeScheme = (onChange: () => void): (() => void) => {
  const media = query();
  media.addEventListener('change', onChange);
  return () => media.removeEventListener('change', onChange);
};

/** The scheme the window is drawn in; re-renders when the OS appearance flips. */
export const useColorScheme = (): ThemeScheme => useSyncExternalStore(subscribeScheme, readScheme);

const applyScheme = () => {
  document.documentElement.dataset.theme = readScheme();
};

/**
 * Keeps `data-theme` on <html> in step with the OS appearance. tokens.css
 * switches its variables on that attribute, and App.css maps them to the
 * Tailwind utilities, so this one attribute re-themes the whole window.
 */
export const applyThemeAttribute = (): void => {
  applyScheme();
  subscribeScheme(applyScheme);
};
