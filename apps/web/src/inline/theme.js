// Inlined into <head> before any content: picks the color scheme and the
// visitor's platform, and keeps both current. Runs synchronously, so the
// page's colors and download buttons are right on the first paint.

/** 'mac' | 'ios' | 'windows' | 'linux' | 'android', from the user agent; macOS when unsure. */
const platform = () => {
  const nav = navigator;
  const ua = nav.userAgent || '';
  // UA-CH names the OS plainly ("macOS", "Windows", "Chrome OS"); the UA
  // string is the fallback, and the only place iOS shows.
  const os = `${(nav.userAgentData && nav.userAgentData.platform) || ''} ${ua}`;
  if (/android/i.test(os)) {
    return 'android';
  }
  // iPadOS asks for desktop sites with a Mac user agent; touch gives it away.
  if (/iphone|ipad|ipod/i.test(ua) || (/mac/i.test(os) && nav.maxTouchPoints > 1)) {
    return 'ios';
  }
  if (/windows/i.test(os)) {
    return 'windows';
  }
  // ChromeOS reads as Linux: it runs Linux apps, not macOS ones.
  if (/linux|x11|cros|chrom(e|ium) ?os/i.test(os)) {
    return 'linux';
  }
  return 'mac';
};

(() => {
  const root = document.documentElement;
  const KEY = 'solunivo-theme';
  const dark = matchMedia('(prefers-color-scheme: dark)');

  /** 'light' | 'dark' | 'auto' — the stored choice, if storage can be read. */
  const stored = () => {
    try {
      const value = localStorage.getItem(KEY);
      return value === 'light' || value === 'dark' ? value : 'auto';
    } catch {
      return 'auto';
    }
  };
  // The choice lives here; storage only carries it to the next visit (and
  // to other tabs), so a browser that refuses storage still gets the
  // scheme the visitor picks.
  let picked = stored();

  const apply = () => {
    const theme = picked === 'auto' ? (dark.matches ? 'dark' : 'light') : picked;
    root.dataset.theme = theme;
    root.dataset.themeChoice = picked;
    for (const button of document.querySelectorAll('[data-set-theme]')) {
      button.setAttribute('aria-pressed', String(button.dataset.setTheme === picked));
    }
    // Images with a dark variant: a forced scheme overrides each <picture>'s
    // OS-driven dark <source>. The browser may already have fetched the
    // OS's variant by then; this only decides which one shows.
    for (const source of document.querySelectorAll('source[data-theme-source]')) {
      source.media =
        picked === 'auto'
          ? '(prefers-color-scheme: dark)'
          : picked === source.dataset.themeSource
            ? 'all'
            : 'not all';
    }
  };

  root.dataset.platform = platform();
  apply();
  dark.addEventListener('change', apply);
  // Again once the markup is there (the pictures and the footer's buttons),
  // and once more on load for the dev server, where React mounts them later.
  document.addEventListener('DOMContentLoaded', apply);
  window.addEventListener('load', apply);
  // A choice made in another tab.
  window.addEventListener('storage', (event) => {
    if (event.key === KEY || event.key === null) {
      picked = stored();
      apply();
    }
  });
  document.addEventListener('click', (event) => {
    const target = event.target;
    const button = target && target.closest ? target.closest('[data-set-theme]') : null;
    if (!button) {
      return;
    }
    picked =
      button.dataset.setTheme === 'light' || button.dataset.setTheme === 'dark'
        ? button.dataset.setTheme
        : 'auto';
    try {
      if (picked === 'auto') {
        localStorage.removeItem(KEY);
      } else {
        localStorage.setItem(KEY, picked);
      }
    } catch {
      // Private mode or storage off: the choice holds until the page is left.
    }
    apply();
  });
})();
