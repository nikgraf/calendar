import { PANE_ICON_PATHS } from './ui/icons.tsx';
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
  mirrors: <MirrorsSection />,
  notifications: (
    <>
      <EventNotificationsSection />
      <BirthdayRemindersSection />
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
      className="flex h-screen flex-col bg-surface-subtle text-ink"
      data-testid="settings-window"
    >
      <header
        className="shrink-0 border-b border-hairline bg-fill pt-2 pb-1.5"
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
                  ? 'bg-fill text-primary'
                  : 'text-ink-secondary hover:bg-fill hover:text-ink'
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
                {PANE_ICON_PATHS[entry.id]}
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
