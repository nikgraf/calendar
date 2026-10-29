// Inlined into <head> before any content: picks the color scheme and the
// visitor's platform, and keeps both current. Runs synchronously so the
// first paint already has the right theme and buttons.

/** 'mac' | 'ios' | 'windows' | 'linux' | 'android', from the user agent; macOS when unsure. */
const platform = () => {
  const nav = navigator;
  const data = nav.userAgentData && nav.userAgentData.platform;
  const ua = nav.userAgent;
  if (/Android/i.test(data || ua)) {
    return 'android';
  }
  if (/iPhone|iPad|iPod/.test(ua) || (/Mac/.test(data || ua) && nav.maxTouchPoints > 1)) {
    return 'ios';
  }
  if (/Windows/.test(data || ua)) {
    return 'windows';
  }
  if (/Mac/.test(data || ua)) {
    return 'mac';
  }
  if (/Linux|X11|CrOS/.test(data || ua)) {
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
  // The choice lives here; storage only carries it to the next visit, so a
  // browser that refuses storage still gets the scheme the visitor picks.
  let picked = stored();

  const apply = () => {
    const theme = picked === 'auto' ? (dark.matches ? 'dark' : 'light') : picked;
    root.dataset.theme = theme;
    root.dataset.themeChoice = picked;
    for (const button of document.querySelectorAll('[data-set-theme]')) {
      button.setAttribute('aria-pressed', String(button.dataset.setTheme === picked));
    }
    // Images with a dark variant: <picture><source media=…> picks before
    // paint, so a forced theme rewrites the media query instead of src.
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
