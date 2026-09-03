import { useEffect, useState } from 'react';

const STATUS_COPY: Record<string, string> = {
  denied: 'Access denied — allow Solunivo under System Settings › Privacy & Security › Reminders.',
  fullAccess: 'Connected.',
  notDetermined: 'Not asked yet.',
  restricted: 'Restricted by a device policy.',
  unavailable: 'Unavailable in this build (no helper).',
  writeOnly: 'Write-only access — full access is needed to show reminders.',
};

/**
 * Reminders permission state + the ask. Lives in Settings so a wrong
 * answer to the OS prompt has a visible way back; the account/lists
 * themselves are managed through the sidebar once connected.
 */
const load = async () => {
  const next = await window.calendarBridge.remindersStatus();
  const found =
    next === 'fullAccess' ? await window.calendarBridge.remindersListLists().catch(() => []) : null;
  return { found, next };
};

export function RemindersSection() {
  const [status, setStatus] = useState<string | null>(null);
  const [lists, setLists] = useState<ReadonlyArray<{ id: string; title: string }> | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let mounted = true;
    void load().then(({ found, next }) => {
      if (mounted) {
        setStatus(next);
        setLists(found);
      }
    });
    return () => {
      mounted = false;
    };
  }, []);

  const request = async () => {
    setBusy(true);
    try {
      await window.calendarBridge.remindersRequestAccess();
      const { found, next } = await load();
      setStatus(next);
      setLists(found);
    } finally {
      setBusy(false);
    }
  };

  if (status === null) {
    return null;
  }
  return (
    <section className="rounded-xl border border-neutral-200 bg-white p-4">
      <h2 className="font-medium">Apple Reminders</h2>
      <p className="mt-1 text-sm text-neutral-500">{STATUS_COPY[status] ?? status}</p>
      {lists ? (
        <p className="mt-1 text-xs text-neutral-400">
          {lists.length} list{lists.length === 1 ? '' : 's'}: {lists.map((l) => l.title).join(', ')}
        </p>
      ) : null}
      {status === 'notDetermined' || status === 'denied' ? (
        <button
          className="mt-3 rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          disabled={busy}
          onClick={() => void request()}
          type="button"
        >
          {status === 'denied' ? 'Check again' : 'Allow access to Reminders'}
        </button>
      ) : null}
    </section>
  );
}
