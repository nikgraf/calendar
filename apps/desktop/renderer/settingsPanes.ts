/** The settings window's panes, in toolbar order (General first, as macOS apps have it). */
export const SETTINGS_PANES = [
  { id: 'general', label: 'General' },
  { id: 'accounts', label: 'Accounts' },
  { id: 'notifications', label: 'Notifications' },
  { id: 'mirrors', label: 'Mirrors' },
  { id: 'agents', label: 'Agents' },
  { id: 'advanced', label: 'Advanced' },
] as const;

export type SettingsPaneId = (typeof SETTINGS_PANES)[number]['id'];

/** The page's hash routes: `#settings` is the settings window, `#settings/<pane>` one of its panes. */
export const SETTINGS_HASH = '#settings';

export const isSettingsRoute = (hash: string): boolean =>
  hash === SETTINGS_HASH || hash.startsWith(`${SETTINGS_HASH}/`);

/** The pane a hash names, or null when it names none (a bare `#settings`, an unknown id). */
export const paneFromHash = (hash: string): SettingsPaneId | null => {
  const id = hash.startsWith(`${SETTINGS_HASH}/`) ? hash.slice(SETTINGS_HASH.length + 1) : '';
  return SETTINGS_PANES.find((pane) => pane.id === id)?.id ?? null;
};
