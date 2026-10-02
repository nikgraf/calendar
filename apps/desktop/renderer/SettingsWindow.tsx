import { type ReactNode, useEffect, useState, useSyncExternalStore } from 'react';
import { AccountsView } from './AccountsView.tsx';
import { AgentsSection } from './agents/AgentsSection.tsx';
import { AppleCalendarSection } from './AppleCalendarSection.tsx';
import { BirthdayRemindersSection } from './BirthdayRemindersSection.tsx';
import { ContactsSection } from './ContactsSection.tsx';
import { EventNotificationsSection } from './EventNotificationsSection.tsx';
import { LocationsSection } from './LocationsSection.tsx';
import { PrivacySection } from './PrivacySection.tsx';
import { RemindersSection } from './RemindersSection.tsx';
import { SettingsFileSection, SettingsTransferSection } from './SettingsFileSection.tsx';
import {
  paneFromHash,
  SETTINGS_HASH,
  SETTINGS_PANES,
  type SettingsPaneId,
} from './settingsPanes.ts';
import { TimeZonesSection } from './TimeZonesSection.tsx';

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
  notifications: (
    <>
      <EventNotificationsSection />
      <BirthdayRemindersSection />
    </>
  ),
};

const PANE_ICON: Record<SettingsPaneId, ReactNode> = {
  accounts: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 19.5c.6-3.4 3.4-5.5 7-5.5s6.4 2.1 7 5.5" />
    </>
  ),
  advanced: (
    <>
      <path d="M4 7h9m5 0h2M4 12h3m5 0h8M4 17h7m5 0h4" />
      <circle cx="15.5" cy="7" r="2" />
      <circle cx="9.5" cy="12" r="2" />
      <circle cx="13.5" cy="17" r="2" />
    </>
  ),
  agents: (
    <>
      <rect height="15" rx="3" width="18" x="3" y="4.5" />
      <path d="m7.5 10 2.5 2.25L7.5 14.5M12.5 14.5h4" />
    </>
  ),
  general: (
    <>
      <circle cx="12" cy="12" r="6.25" />
      <circle cx="12" cy="12" r="2.25" />
      <path d="M12 3v2.75M12 18.25V21M3 12h2.75M18.25 12H21M5.64 5.64l1.94 1.94M16.42 16.42l1.94 1.94M5.64 18.36l1.94-1.94M16.42 7.58l1.94-1.94" />
    </>
  ),
  notifications: (
    <>
      <path d="M6.5 16.5v-5a5.5 5.5 0 0 1 11 0v5l1.5 2H5z" />
      <path d="M10 20.5a2.1 2.1 0 0 0 4 0" />
    </>
  ),
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
 * a pane toolbar in the title bar, the window title naming the pane in
 * view, changes applying as they are made — the macOS settings layout.
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
 * look at another pane.
 */
export function SettingsWindow() {
  const hash = useSyncExternalStore(subscribeHash, readHash);
  const [fallback] = useState<SettingsPaneId>(() => storedPane() ?? 'general');
  const pane = paneFromHash(hash) ?? fallback;
  const label = SETTINGS_PANES.find((entry) => entry.id === pane)!.label;

  useEffect(() => {
    document.title = label;
    try {
      window.localStorage.setItem(LAST_PANE_KEY, pane);
    } catch {
      // Without storage the window just reopens on General.
    }
  }, [label, pane]);

  return (
    <div
      className="flex h-screen flex-col bg-neutral-50 text-neutral-900"
      data-testid="settings-window"
    >
      <header
        className="shrink-0 border-b border-neutral-200 bg-neutral-100 pt-2 pb-1.5"
        style={{ WebkitAppRegion: 'drag' } as React.CSSProperties}
      >
        <h1 className="text-center text-[13px] font-semibold" data-testid="settings-title">
          {label}
        </h1>
        <div aria-label="Settings" className="mt-1.5 flex justify-center gap-1" role="tablist">
          {SETTINGS_PANES.map((entry) => (
            <button
              aria-controls={`settings-pane-${entry.id}`}
              aria-selected={pane === entry.id}
              className={`flex w-[84px] flex-col items-center gap-0.5 rounded-md px-1 py-1 text-[11px] ${
                pane === entry.id
                  ? 'bg-neutral-200/80 text-blue-600'
                  : 'text-neutral-500 hover:bg-neutral-200/50 hover:text-neutral-800'
              }`}
              data-testid={`settings-tab-${entry.id}`}
              key={entry.id}
              onClick={() => showPane(entry.id)}
              role="tab"
              style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
              type="button"
            >
              <svg
                aria-hidden="true"
                className="size-6"
                fill="none"
                stroke="currentColor"
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth="1.5"
                viewBox="0 0 24 24"
              >
                {PANE_ICON[entry.id]}
              </svg>
              {entry.label}
            </button>
          ))}
        </div>
      </header>
      {SETTINGS_PANES.map((entry) => (
        <div
          aria-label={entry.label}
          className="min-h-0 flex-1 overflow-y-auto px-10 py-6"
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
  );
}
