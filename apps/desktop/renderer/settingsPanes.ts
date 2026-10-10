import { EXPERIMENTAL_COPY } from '@calendar/core';

/**
 * The settings window's panes, in sidebar order (General first, as macOS
 * apps have it; the experimental ones last, under their own heading).
 * `keywords` are what the sidebar's search matches besides the label: the
 * sections and settings a pane holds, as a user would name them.
 */
export const SETTINGS_PANES = [
  {
    id: 'general',
    keywords: ['time zones', 'clock', 'location', 'map', 'privacy', 'screen'],
    label: 'General',
  },
  {
    id: 'accounts',
    keywords: ['google', 'apple', 'calendar', 'reminders', 'contacts', 'sign in', 'tasks'],
    label: 'Accounts',
  },
  {
    id: 'notifications',
    keywords: ['alerts', 'reminders', 'birthdays', 'events'],
    label: 'Notifications',
  },
  {
    // Not `settings-file`: windows.ts accepts letters only in a pane id.
    id: 'file',
    keywords: ['export', 'import', 'backup', 'transfer', 'dotfiles', 'jsonc'],
    label: 'Settings File',
  },
  {
    id: 'mirrors',
    keywords: ['shared calendar', 'copy', 'availability', 'busy'],
    label: 'Mirrors',
  },
  {
    id: 'agents',
    keywords: ['mcp', 'cli', 'token', 'ai', 'claude', 'permissions', 'grants'],
    label: 'Agents',
  },
] as const;

export type SettingsPaneId = (typeof SETTINGS_PANES)[number]['id'];
export type SettingsPane = (typeof SETTINGS_PANES)[number];

/**
 * The panes listed under "Experimental": features that may still change
 * or go away. The heading names the group; each such pane says what it
 * means at its top.
 */
const EXPERIMENTAL_PANES: ReadonlySet<SettingsPaneId> = new Set(['mirrors', 'agents']);

export const isExperimentalPane = (id: SettingsPaneId): boolean => EXPERIMENTAL_PANES.has(id);

/** The page's hash routes: `#settings` is the settings window, `#settings/<pane>` one of its panes. */
export const SETTINGS_HASH = '#settings';

export const isSettingsRoute = (hash: string): boolean =>
  hash === SETTINGS_HASH || hash.startsWith(`${SETTINGS_HASH}/`);

/** The pane a hash names, or null when it names none (a bare `#settings`, an unknown id). */
export const paneFromHash = (hash: string): SettingsPaneId | null => {
  const id = hash.startsWith(`${SETTINGS_HASH}/`) ? hash.slice(SETTINGS_HASH.length + 1) : '';
  return SETTINGS_PANES.find((pane) => pane.id === id)?.id ?? null;
};

/**
 * The panes a search shows: every pane for an empty query, otherwise
 * those whose label or keywords contain every word of it (case-folded) —
 * an experimental pane's heading counts as one of its words. Order is
 * kept.
 */
export const filterPanes = (query: string): ReadonlyArray<SettingsPane> => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return SETTINGS_PANES;
  }
  return SETTINGS_PANES.filter((pane) => {
    const haystack = [
      pane.label,
      ...pane.keywords,
      isExperimentalPane(pane.id) ? EXPERIMENTAL_COPY.label : '',
    ]
      .join(' ')
      .toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
};
