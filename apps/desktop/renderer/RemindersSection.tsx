import { useAccounts, useBackendMutations, useTaskLists } from '@calendar/app-state';
import { useEffect, useState } from 'react';

const STATUS_COPY: Record<string, string> = {
  denied: 'Access denied — allow Solunivo under System Settings › Privacy & Security › Reminders.',
  fullAccess: 'Access granted.',
  notDetermined: 'Not asked yet.',
  restricted: 'Restricted by a device policy.',
  unavailable: 'Unavailable in this build (no helper).',
  writeOnly: 'Write-only access — full access is needed to show reminders.',
};

/**
 * Reminders permission state + the connect action. The permission *status*
 * is a window-level concern and comes over preload IPC; connecting goes
 * through the `connectReminders` rpc so the account row and the first sync
 * happen too (a bare TCC grant on its own shows nothing). Lists come from
 * the same atoms the sidebar uses.
 */
export function RemindersSection() {
  const [status, setStatus] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { connectReminders } = useBackendMutations();
  const accounts = useAccounts();
  const taskLists = useTaskLists();
  const apple = accounts.find((account) => account.provider === 'apple');
  const lists = apple ? taskLists.filter((list) => list.accountId === apple.id) : [];

  useEffect(() => {
    let mounted = true;
    void window.calendarBridge.remindersStatus().then((next) => {
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
      const result = await connectReminders(undefined);
      setStatus(await window.calendarBridge.remindersStatus());
      if (!result.granted) {
        setNote(
          'Reminders access was not granted. Allow it under System Settings › Privacy & Security › Reminders, then try again.',
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
    <section className="rounded-xl border border-neutral-200 bg-white p-4">
      <h2 className="font-medium">Apple Reminders</h2>
      <p className="mt-1 text-sm text-neutral-500">
        {connected ? 'Connected.' : (STATUS_COPY[status] ?? status)}
      </p>
      {connected ? (
        <p className="mt-1 text-xs text-neutral-400">
          {lists.length} list{lists.length === 1 ? '' : 's'}
          {lists.length > 0 ? `: ${lists.map((list) => list.title).join(', ')}` : ''}
        </p>
      ) : null}
      {note ? <p className="mt-2 text-sm text-red-600">{note}</p> : null}
      {!connected && status !== 'unavailable' && status !== 'restricted' ? (
        <button
          className="mt-3 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          disabled={busy}
          onClick={() => void connect()}
          type="button"
        >
          {status === 'fullAccess' ? 'Connect Apple Reminders' : 'Allow access to Reminders'}
        </button>
      ) : null}
    </section>
  );
}
