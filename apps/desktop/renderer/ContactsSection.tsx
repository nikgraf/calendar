import { useAccounts, useBackendMutations } from '@calendar/app-state';
import { useEffect, useState } from 'react';

const STATUS_COPY: Record<string, string> = {
  authorized: 'Access granted — people from your address book appear as you type an invitee.',
  denied: 'Access denied — allow Solunivo under System Settings › Privacy & Security › Contacts.',
  limited: 'Partial access granted.',
  notDetermined: 'Not asked yet.',
  restricted: 'Restricted by a device policy.',
  unavailable: 'Unavailable in this build (no helper).',
};

/**
 * Contacts permission state + the ask, mirroring RemindersSection. The
 * status is a window-level concern (preload IPC); the ask goes through
 * the `connectContacts` rpc so the typeahead cache loads right after a
 * grant. Google contacts need no prompt, only the re-consented scopes.
 */
export function ContactsSection() {
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { connectContacts } = useBackendMutations();
  const accounts = useAccounts();
  const googleWithout = accounts.filter(
    (account) => account.provider === 'google' && !account.contactsEnabled,
  );

  useEffect(() => {
    let mounted = true;
    void window.calendarBridge.contactsStatus().then((next) => {
      if (mounted) {
        setStatus(next);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  const connect = async () => {
    setBusy(true);
    try {
      await connectContacts(undefined);
    } finally {
      setStatus(await window.calendarBridge.contactsStatus());
      setBusy(false);
    }
  };

  if (status === null) {
    return null;
  }
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-4">
      <h2 className="font-medium">Contacts</h2>
      <p className="mt-1 text-sm text-neutral-500">{STATUS_COPY[status] ?? status}</p>
      {googleWithout.length > 0 ? (
        <p className="mt-1 text-xs text-neutral-400">
          Google contacts are not enabled for {googleWithout.map((a) => a.email).join(', ')} —
          re-run “Add Google Account” to grant the contacts scopes.
        </p>
      ) : null}
      {status === 'notDetermined' || status === 'denied' ? (
        <button
          className="mt-3 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          disabled={busy}
          onClick={() => void connect()}
          type="button"
        >
          {status === 'denied' ? 'Check again' : 'Allow access to Contacts'}
        </button>
      ) : null}
    </section>
  );
}
