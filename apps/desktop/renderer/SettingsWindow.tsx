import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { AccountsView } from './AccountsView.tsx';
import { AgentsSection } from './agents/AgentsSection.tsx';
import { AppleCalendarSection } from './AppleCalendarSection.tsx';
import { BirthdayRemindersSection } from './BirthdayRemindersSection.tsx';
import { ContactsSection } from './ContactsSection.tsx';
import { EventNotificationsSection } from './EventNotificationsSection.tsx';
import { LocationsSection } from './LocationsSection.tsx';
import { MirrorsSection } from './MirrorsSection.tsx';
import { PrivacySection } from './PrivacySection.tsx';
import { RemindersSection } from './RemindersSection.tsx';
import { SettingsFileSection, SettingsTransferSection } from './SettingsFileSection.tsx';
import {
  filterPanes,
  paneFromHash,
  SETTINGS_HASH,
  SETTINGS_PANES,
  type SettingsPaneId,
} from './settingsPanes.ts';
import { TimeZonesSection } from './TimeZonesSection.tsx';
import { PaneIcon, SearchIcon } from './ui/icons.tsx';

const LAST_PANE_KEY = 'settings.lastPane';

/** The pane viewed last, so the window reopens where it was closed. */
const storedPane = (): SettingsPaneId | null => {
  try {
    return paneFromHash(`${SETTINGS_HASH}/${window.localStorage.getItem(LAST_PANE_KEY) ?? ''}`);
  } catch {
    return null;
  }
};

const PANE_CONTENT: Record<SettingsPaneId, ReactNode> = {
  accounts: (
    <>
      <AccountsView />
      <AppleCalendarSection />
      <RemindersSection />
      <ContactsSection />
    </>
  ),
  advanced: (
    <>
      <SettingsTransferSection />
      <SettingsFileSection />
    </>
  ),
  agents: <AgentsSection />,
  general: (
    <>
      <TimeZonesSection />
      <LocationsSection />
      <PrivacySection />
    </>
  ),
  mirrors: <MirrorsSection />,
  notifications: (
    <>
      <EventNotificationsSection />
      <BirthdayRemindersSection />
    </>
  ),
};

/** The icon squares' tints: one hue per pane, like System Settings. */
const PANE_TINT: Record<SettingsPaneId, string> = {
  accounts: 'bg-event-blue text-on-event-blue',
  advanced: 'bg-fill text-ink-secondary',
  agents: 'bg-event-lilac text-on-event-lilac',
  general: 'bg-fill text-ink',
  mirrors: 'bg-event-mint text-on-event-mint',
  notifications: 'bg-event-blush text-on-event-blush',
};

const subscribeHash = (onChange: () => void): (() => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};
const readHash = (): string => window.location.hash;
/** A tab click. A same-document navigation: `hashchange` follows, no reload, no history entry. */
const showPane = (id: SettingsPaneId): void => window.location.replace(`${SETTINGS_HASH}/${id}`);

/**
 * The settings window's page (the main process loads it at `#settings`):
 * a sidebar of panes with a search field, the pane's title over its
 * content, changes applying as they are made — the System Settings
 * layout.
 *
 * The URL hash is the pane, and the only place it is kept: the main
 * process opens the window on a pane, or moves an open one to it, by
 * navigating the hash (windows.ts), and a tab click navigates it too.
 * Nothing here writes its own idea of the pane back over the hash, so a
 * request from the main process cannot be lost to this page's timing —
 * it holds whether it lands before the first render or after. A hash that
 * names no pane (the bare `#settings` of a window opened without one)
 * shows the pane viewed last.
 *
 * Every pane stays mounted and only the one in view is shown: a half-typed
 * agent name, a token shown once and each pane's scroll position survive a
 * look at another pane. The search only narrows the sidebar; the pane in
 * view stays, even when it is filtered out of the list.
 */
export function SettingsWindow() {
  const hash = useSyncExternalStore(subscribeHash, readHash);
  const [fallback] = useState<SettingsPaneId>(() => storedPane() ?? 'general');
  const pane = paneFromHash(hash) ?? fallback;
  const label = SETTINGS_PANES.find((entry) => entry.id === pane)!.label;
  const [query, setQuery] = useState('');
  const shown = filterPanes(query);

  useEffect(() => {
    document.title = label;
    try {
      window.localStorage.setItem(LAST_PANE_KEY, pane);
    } catch {
      // Without storage the window just reopens on General.
    }
  }, [label, pane]);

  return (
    <div className="flex h-screen bg-canvas text-ink" data-testid="settings-window">
      <nav
        aria-label="Settings"
        className="flex w-52 shrink-0 flex-col border-r border-hairline bg-surface-subtle"
      >
        {/* The traffic lights sit in this strip; the page draws no title bar of its own. */}
        <div className="h-12 shrink-0" style={{ WebkitAppRegion: 'drag' } as React.CSSProperties} />
        <label className="mx-3 mb-2 flex h-7 items-center gap-1.5 rounded-control bg-fill px-2 text-xs text-ink-secondary focus-within:ring-2 focus-within:ring-focus">
          <SearchIcon size={13} />
          <input
            aria-label="Search settings"
            className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-secondary"
            data-testid="settings-search"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search"
            type="search"
            value={query}
          />
        </label>
        <div className="flex flex-col gap-0.5 px-2" role="tablist">
          {shown.map((entry) => (
            <button
              aria-controls={`settings-pane-${entry.id}`}
              aria-selected={pane === entry.id}
              className={`flex h-8 items-center gap-2.5 rounded-control px-2 text-left text-[13px] ${
                pane === entry.id ? 'bg-selection text-on-selection' : 'hover:bg-fill'
              }`}
              data-testid={`settings-tab-${entry.id}`}
              key={entry.id}
              onClick={() => showPane(entry.id)}
              role="tab"
              type="button"
            >
              <span
                className={`flex size-5.5 shrink-0 items-center justify-center rounded-[6px] ${PANE_TINT[entry.id]}`}
              >
                <PaneIcon pane={entry.id} size={13} />
              </span>
              {entry.label}
            </button>
          ))}
          {shown.length === 0 ? (
            <p className="px-2 py-3 text-xs text-ink-secondary">No settings match.</p>
          ) : null}
        </div>
      </nav>
      <div className="flex min-w-0 flex-1 flex-col">
        <header
          className="flex h-12 shrink-0 items-center px-8"
          style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
        >
          <h1 className="text-[15px] font-semibold" data-testid="settings-title">
            {label}
          </h1>
        </header>
        {SETTINGS_PANES.map((entry) => (
          <div
            aria-label={entry.label}
            className="min-h-0 flex-1 overflow-y-auto px-8 pt-1 pb-8"
            data-testid={`settings-pane-${entry.id}`}
            hidden={pane !== entry.id}
            id={`settings-pane-${entry.id}`}
            key={entry.id}
            role="tabpanel"
          >
            <div className="flex flex-col gap-4">{PANE_CONTENT[entry.id]}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
