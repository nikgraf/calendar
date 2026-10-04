import {
  removeAccountQuestion,
  useAccounts,
  useBackendMutations,
  useCalendars,
  useGuardedMutations,
  usePendingOps,
  useSyncStatus,
} from '@calendar/app-state';
import { type Account, historyStatusLabel, isAppleCalendarAccount } from '@calendar/core';
import { useState } from 'react';

/** The connected accounts and their calendars: the top of the settings window's Accounts pane. */
export function AccountsView() {
  const accounts = useAccounts();
  const syncStatus = useSyncStatus();
  // An account that cannot sync (re-auth pending) never finishes an
  // import, so "importing" would be a lie there; what it already holds
  // is still worth stating.
  const historyLine = (account: Account): string | null => {
    const status = syncStatus.find((entry) => entry.accountId === account.id);
    if (!status || (status.importing && account.status !== 'ok')) {
      return null;
    }
    return historyStatusLabel(status);
  };
  const calendars = useCalendars();
  const mutations = useBackendMutations();
  const guarded = useGuardedMutations();
  const pendingOps = usePendingOps();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** The account whose Remove is waiting for a yes (see removeAccountQuestion). */
  const [confirmingRemove, setConfirmingRemove] = useState<string | null>(null);

  const remove = (account: Account) => {
    if (removeAccountQuestion(account, pendingOps)) {
      setConfirmingRemove(account.id);
      return;
    }
    void guarded.removeAccount({ accountId: account.id });
  };

  const addAccount = async () => {
    setBusy(true);
    setError(null);
    try {
      await mutations.addAccount(undefined);
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <header className="flex items-center justify-between">
        <h2 className="font-medium">Connected accounts</h2>
        <button
          className="rounded-lg bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          disabled={busy}
          onClick={() => void addAccount()}
          type="button"
        >
          {busy ? 'Waiting for Google…' : 'Add Google Account'}
        </button>
      </header>

      {error ? (
        <div className="select-text rounded-lg border border-red-200 bg-red-50 p-3 text-sm whitespace-pre-wrap text-red-700">
          {error}
        </div>
      ) : null}

      {accounts.length === 0 && !error ? (
        <p className="text-neutral-500">
          No Google accounts connected yet. Add one to see your calendars.
        </p>
      ) : null}

      {accounts.map((account) => (
        <section className="rounded-xl border border-neutral-200 bg-white p-4" key={account.id}>
          <div className="flex items-center justify-between">
            <div>
              <p className="select-text font-medium">{account.displayName ?? account.email}</p>
              {historyLine(account) ? (
                <p className="text-xs text-neutral-500" data-testid={`sync-history-${account.id}`}>
                  {historyLine(account)}
                </p>
              ) : null}
              <p className="select-text text-sm text-neutral-500">
                {account.provider === 'apple' ? 'This Mac' : account.email}
                {account.status === 'reauth_required' ? (
                  account.provider === 'apple' ? (
                    <span className="ml-2 text-amber-600">
                      Access off — allow{' '}
                      {isAppleCalendarAccount(account) ? 'Calendars' : 'Reminders'} in System
                      Settings › Privacy & Security.
                    </span>
                  ) : (
                    <button
                      className="ml-2 text-blue-600 hover:underline"
                      onClick={() => void addAccount()}
                      type="button"
                    >
                      {account.displayName ? 'Sign in again' : 'Sign in'}
                    </button>
                  )
                ) : null}
              </p>
            </div>
            <button
              className="text-sm text-red-600 hover:underline"
              data-testid={`remove-account-${account.id}`}
              onClick={() => remove(account)}
              type="button"
            >
              Remove
            </button>
          </div>
          {confirmingRemove === account.id ? (
            <RemoveAccountConfirm
              onCancel={() => setConfirmingRemove(null)}
              onRemove={() => {
                setConfirmingRemove(null);
                void guarded.removeAccount({ accountId: account.id });
              }}
              question={removeAccountQuestion(account, pendingOps)}
            />
          ) : null}
          <ul className="mt-3 space-y-1">
            {calendars
              .filter((calendar) => calendar.accountId === account.id)
              .map((calendar) => (
                <li
                  className="flex items-center gap-2 text-sm"
                  key={`${calendar.accountId}:${calendar.id}`}
                >
                  <input
                    checked={calendar.isVisible}
                    onChange={(changeEvent) =>
                      void guarded.setCalendarVisible({
                        accountId: calendar.accountId,
                        calendarId: calendar.id,
                        isVisible: changeEvent.target.checked,
                      })
                    }
                    type="checkbox"
                  />
                  <span
                    className="inline-block size-3 rounded-full"
                    style={{ backgroundColor: calendar.colorHex }}
                  />
                  <span>{calendar.summary}</span>
                  {calendar.isPrimary ? (
                    <span className="text-xs text-neutral-400">primary</span>
                  ) : null}
                </li>
              ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

/** The yes/no under an account before it, and its unsynced changes, are removed. */
function RemoveAccountConfirm({
  onCancel,
  onRemove,
  question,
}: {
  onCancel: () => void;
  onRemove: () => void;
  question: ReturnType<typeof removeAccountQuestion>;
}) {
  return (
    <div
      className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm"
      data-testid="remove-account-confirm"
      role="alertdialog"
    >
      <p className="font-medium text-red-800">{question?.title}</p>
      <p className="mt-1 text-red-700">{question?.message}</p>
      <div className="mt-3 flex justify-end gap-2">
        <button
          autoFocus
          className="rounded-md px-3 py-1 text-neutral-700 hover:bg-white"
          onClick={onCancel}
          type="button"
        >
          Cancel
        </button>
        <button
          className="rounded-md bg-red-600 px-3 py-1 font-medium text-white hover:bg-red-500"
          data-testid="remove-account-yes"
          onClick={onRemove}
          type="button"
        >
          Remove
        </button>
      </div>
    </div>
  );
}
