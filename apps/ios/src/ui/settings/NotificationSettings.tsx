import {
  useBackendMutations,
  useBirthdayReminderSettings,
  useEventNotificationSettings,
  useSettingsEditor,
} from '@calendar/app-state';
import type { BirthdayReminderSettings, EventNotificationSettings } from '@calendar/core';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { type NotificationPermission, notificationPermission } from '../../notifications.ts';

/**
 * iOS's notification permission, read without asking on mount and
 * whenever the app comes back (the user may have just changed it in the
 * Settings app); `recheck` reads it again after a save that asked.
 */
const useNotificationPermission = (): [NotificationPermission | null, () => void] => {
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let mounted = true;
    const read = () => {
      void notificationPermission().then((next) => {
        if (mounted) {
          setPermission(next);
        }
      });
    };
    read();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        read();
      }
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, [reads]);
  return [permission, () => setReads((count) => count + 1)];
};

export interface NotificationEditor<A> {
  /** The last save failed (not a refusal: an error). */
  failure: string | null;
  /** The last save found notifications not allowed (it may have just asked). */
  refused: boolean;
  save: (change: Partial<A>) => void;
  settings: A | null;
}

/** One device-local notification setting: its editor, plus what the last save learned. */
const useNotificationEditor = <A extends { readonly enabled: boolean }>(
  stored: A | null,
  persistTo: (next: A) => Promise<{ readonly notificationsGranted: boolean }>,
  recheck: () => void,
): NotificationEditor<A> => {
  const [settings, persist] = useSettingsEditor(stored, persistTo);
  const [failure, setFailure] = useState<string | null>(null);
  const [refused, setRefused] = useState(false);
  const save = (change: Partial<A>) =>
    void persist(change).then(
      ({ notificationsGranted }) => {
        setFailure(null);
        setRefused(!notificationsGranted);
        recheck();
      },
      (error: unknown) => setFailure(String(error)),
    );
  return { failure, refused, save, settings };
};

interface NotificationSettingsValue {
  birthdays: NotificationEditor<BirthdayReminderSettings>;
  events: NotificationEditor<EventNotificationSettings>;
  permission: NotificationPermission | null;
}

const NotificationSettingsContext = createContext<NotificationSettingsValue | null>(null);

/**
 * The notification settings' editors, held above the Settings pages. The
 * birthday settings are edited on two pages (Notifications, and Remind
 * Me pushed over it); each editor sends its own last value as the whole
 * struct, so two of them would overwrite each other's changes. One shared
 * editor per setting keeps them in step.
 */
export function NotificationSettingsProvider({ children }: { children: ReactNode }) {
  const { setBirthdayReminderSettings, setEventNotificationSettings } = useBackendMutations();
  const [permission, recheck] = useNotificationPermission();
  const events = useNotificationEditor(
    useEventNotificationSettings(),
    setEventNotificationSettings,
    recheck,
  );
  const birthdays = useNotificationEditor(
    useBirthdayReminderSettings(),
    setBirthdayReminderSettings,
    recheck,
  );
  return (
    <NotificationSettingsContext.Provider value={{ birthdays, events, permission }}>
      {children}
    </NotificationSettingsContext.Provider>
  );
}

/** The shared notification editors; only inside `NotificationSettingsProvider`. */
export const useNotificationSettings = (): NotificationSettingsValue => {
  const value = useContext(NotificationSettingsContext);
  if (!value) {
    throw new Error('useNotificationSettings outside NotificationSettingsProvider');
  }
  return value;
};

/** Whether a switched-on setting cannot notify: iOS said no, now or on its last save. */
export const notificationsBlocked = (
  editor: NotificationEditor<{ readonly enabled: boolean }>,
  permission: NotificationPermission | null,
): boolean =>
  editor.settings?.enabled === true &&
  permission !== 'granted' &&
  (editor.refused || permission === 'denied');
