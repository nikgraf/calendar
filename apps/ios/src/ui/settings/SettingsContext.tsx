import { useBackendMutations } from '@calendar/app-state';
import { isSignInCancelled } from '@calendar/core';
import { Effect } from 'effect';
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState, Linking } from 'react-native';
import { iosAppleCalendarClient } from '../../appleCalendarClient.ts';
import { iosContactsClient } from '../../contactsClient.ts';
import { iosRemindersClient } from '../../remindersClient.ts';

export const IOS_SETTINGS_PATH = 'Settings › Privacy & Security';
/**
 * Re-reads of a permission status after a prompt was answered (~10 s in
 * all): iOS records the answer a moment after the alert closes, and a CI
 * runner has shown several seconds of "notDetermined" after "Allow".
 */
const STATUS_SETTLE_TRIES = 40;
const STATUS_SETTLE_MS = 200;

export type Connection = 'calendar' | 'contacts' | 'google' | 'reminders';
export type DeviceConnection = Exclude<Connection, 'google'>;

interface SettingsConnections {
  /** Google sign-in; `loginHint` is the account being reconnected, so Google opens on it. */
  addAccount: (loginHint?: string) => Promise<void>;
  /** A sign-in or device connection is in flight; every connect action waits. */
  busy: boolean;
  /** The Apple Calendar permission status (`checking…` until read). */
  calendar: string;
  connectDevice: (provider: DeviceConnection) => Promise<void>;
  connecting: Connection | null;
  contacts: string;
  /** The last Contacts connection did not finish, whatever iOS reports now. */
  contactsConnectionFailed: boolean;
  /** The last failure of an action started on any Settings page. */
  error: string | null;
  openSettings: () => Promise<void>;
  reminders: string;
}

const SettingsConnectionsContext = createContext<SettingsConnections | null>(null);

/**
 * What the Settings pages share about connections: the three Apple
 * permission statuses (read on open and whenever the app comes back,
 * since the user may have just changed them in iOS Settings), Google
 * sign-in, the device connects, and the last error. Mounted once by the
 * Settings stack, so a pushed page and the page under it agree.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const mutations = useBackendMutations();
  const [connecting, setConnecting] = useState<Connection | null>(null);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [contacts, setContacts] = useState('checking…');
  const [contactsConnectionFailed, setContactsConnectionFailed] = useState(false);
  const [reminders, setReminders] = useState('checking…');
  const [calendar, setCalendar] = useState('checking…');
  const refreshVersion = useRef(0);

  const refreshPermissions = useCallback(async () => {
    const version = ++refreshVersion.current;
    const [contactsStatus, remindersStatus, calendarStatus] = await Promise.all([
      Effect.runPromise(
        iosContactsClient.status().pipe(Effect.orElseSucceed(() => 'Could not check access.')),
      ),
      Effect.runPromise(
        iosRemindersClient.status().pipe(Effect.orElseSucceed(() => 'Could not check access.')),
      ),
      Effect.runPromise(
        iosAppleCalendarClient.status().pipe(Effect.orElseSucceed(() => 'Could not check access.')),
      ),
    ]);
    if (version === refreshVersion.current) {
      setContacts(contactsStatus);
      setReminders(remindersStatus);
      setCalendar(calendarStatus);
    }
    return { calendar: calendarStatus, contacts: contactsStatus, reminders: remindersStatus };
  }, []);

  useEffect(() => {
    void refreshPermissions();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        void refreshPermissions();
      }
    });
    return () => {
      refreshVersion.current += 1;
      subscription.remove();
    };
  }, [refreshPermissions]);

  const connectDevice = useCallback(
    async (provider: DeviceConnection) => {
      if (busyRef.current) {
        return;
      }
      busyRef.current = true;
      setConnecting(provider);
      setError(null);
      let granted: boolean | undefined;
      const name =
        provider === 'contacts'
          ? 'Contacts'
          : provider === 'calendar'
            ? 'Apple Calendar'
            : 'Apple Reminders';
      try {
        const connect =
          provider === 'contacts'
            ? mutations.connectContacts
            : provider === 'calendar'
              ? mutations.connectAppleCalendar
              : mutations.connectReminders;
        granted = (await connect(undefined)).granted;
        if (provider === 'contacts') {
          setContactsConnectionFailed(!granted);
        }
      } catch (error) {
        if (provider === 'contacts') {
          setContactsConnectionFailed(true);
        }
        setError(
          `Could not connect ${name}: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        let statuses = await refreshPermissions();
        // iOS records the answer shortly after the prompt closes: a read right
        // after "Allow" or "Don't Allow" can still say notDetermined, which
        // left the connect row up after a grant and reported "the prompt did
        // not open" after a refusal. Give it a moment before trusting it.
        for (
          let attempt = 0;
          granted !== undefined &&
          statuses[provider] === 'notDetermined' &&
          attempt < STATUS_SETTLE_TRIES;
          attempt += 1
        ) {
          await new Promise((resolve) => setTimeout(resolve, STATUS_SETTLE_MS));
          statuses = await refreshPermissions();
        }
        if (granted === false) {
          const status = statuses[provider];
          if (status === 'notDetermined') {
            setError(`The ${name} permission prompt did not open. Try again.`);
          } else if (status === 'authorized' || status === 'limited' || status === 'fullAccess') {
            setError(`${name} access is allowed, but the connection did not finish. Try again.`);
          } else if (!['denied', 'restricted', 'unavailable', 'writeOnly'].includes(status)) {
            setError(`${name}: ${status} Try again.`);
          }
        }
        busyRef.current = false;
        setConnecting(null);
      }
    },
    [mutations, refreshPermissions],
  );

  const openSettings = useCallback(async () => {
    try {
      await Linking.openSettings();
    } catch (error) {
      setError(
        `Could not open Settings: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }, []);

  const addAccount = useCallback(
    async (loginHint?: string) => {
      if (busyRef.current) {
        return;
      }
      busyRef.current = true;
      setConnecting('google');
      setError(null);
      try {
        await mutations.addAccount(loginHint === undefined ? {} : { loginHint });
      } catch (error) {
        // A dismissed sheet is the user changing their mind, not an error.
        if (!isSignInCancelled(error)) {
          setError(String(error));
        }
      } finally {
        busyRef.current = false;
        setConnecting(null);
      }
    },
    [mutations],
  );

  const value = useMemo(
    () => ({
      addAccount,
      busy: connecting !== null,
      calendar,
      connectDevice,
      connecting,
      contacts,
      contactsConnectionFailed,
      error,
      openSettings,
      reminders,
    }),
    [
      addAccount,
      calendar,
      connectDevice,
      connecting,
      contacts,
      contactsConnectionFailed,
      error,
      openSettings,
      reminders,
    ],
  );
  return (
    <SettingsConnectionsContext.Provider value={value}>
      {children}
    </SettingsConnectionsContext.Provider>
  );
}

/** The Settings stack's shared connection state; only inside `SettingsProvider`. */
export const useSettingsConnections = (): SettingsConnections => {
  const value = useContext(SettingsConnectionsContext);
  if (!value) {
    throw new Error('useSettingsConnections outside SettingsProvider');
  }
  return value;
};
