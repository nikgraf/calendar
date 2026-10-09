import {
  appleCalendarStatusCopy,
  useAccounts,
  useBackendMutations,
  useCalendars,
} from '@calendar/app-state';
import { isAppleCalendarAccount } from '@calendar/core';
import { useEffect, useState } from 'react';

const SETTINGS_PATH = 'System Settings › Privacy & Security';

/**
 * Calendar-app permission state + the connect action, like Reminders: the
 * permission *status* comes over preload IPC; connecting goes through the
 * `connectAppleCalendar` rpc so the account row and the first calendar
 * mirror happen too. Calendars come from the same atoms the sidebar uses.
 */
export function AppleCalendarSection() {
  const [status, setStatus] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { connectAppleCalendar } = useBackendMutations();
  const accounts = useAccounts();
  const calendars = useCalendars();
  const apple = accounts.find(isAppleCalendarAccount);
  const lists = apple ? calendars.filter((calendar) => calendar.accountId === apple.id) : [];

  useEffect(() => {
    let mounted = true;
    void window.calendarBridge.appleCalendarStatus().then((next) => {
      if (mounted) {
        setStatus(next);
      }
    });
    return () => {
      mounted = false;
    };
  }, [apple?.status]);

  const connect = async () => {
    setBusy(true);
    setNote(null);
    try {
      const result = await connectAppleCalendar(undefined);
      setStatus(await window.calendarBridge.appleCalendarStatus());
      if (!result.granted) {
        setNote(
          'Calendar access was not granted. Allow it under System Settings › Privacy & Security › Calendars, then try again.',
        );
      }
    } catch (error) {
      setNote(String(error));
    } finally {
      setBusy(false);
    }
  };

  if (status === null) {
    return null;
  }
  const connected = apple !== undefined && apple.status === 'ok';
  return (
    <section className="rounded-popover bg-surface-subtle p-4">
      <h2 className="font-medium">Apple Calendar</h2>
      <p className="mt-1 text-sm text-ink-secondary">
        {connected ? 'Connected.' : (appleCalendarStatusCopy(status, SETTINGS_PATH) ?? status)}
      </p>
      {connected ? (
        <p className="mt-1 text-xs text-ink-secondary">
          {lists.length} calendar{lists.length === 1 ? '' : 's'}
          {lists.length > 0 ? `: ${lists.map((calendar) => calendar.summary).join(', ')}` : ''}
        </p>
      ) : null}
      {note ? <p className="mt-2 text-sm text-danger">{note}</p> : null}
      {!connected && status !== 'unavailable' && status !== 'restricted' ? (
        <button
          className="mt-3 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-on-primary hover:bg-primary-hover disabled:opacity-50"
          disabled={busy}
          onClick={() => void connect()}
          type="button"
        >
          {status === 'fullAccess' ? 'Connect Apple Calendar' : 'Allow access to Calendars'}
        </button>
      ) : null}
    </section>
  );
}
