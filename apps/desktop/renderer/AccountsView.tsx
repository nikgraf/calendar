import type { Account, CalendarInfo } from '@calendar/core';
import { Effect } from 'effect';
import { useCallback, useEffect, useState } from 'react';
import { backend } from './backend.ts';

export function AccountsView() {
  const [accounts, setAccounts] = useState<ReadonlyArray<Account>>([]);
  const [calendars, setCalendars] = useState<ReadonlyArray<CalendarInfo>>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const loadedAccounts = await Effect.runPromise(backend.listAccounts(undefined));
      setAccounts(loadedAccounts);
      setCalendars(
        loadedAccounts.length > 0 ? await Effect.runPromise(backend.listCalendars({})) : [],
      );
      setError(null);
    } catch (error) {
      setError(String(error));
    }
  }, []);

  useEffect(() => {
    // All setState calls happen after awaits — no synchronous cascade.
    // eslint-disable-next-line react-hooks-js/set-state-in-effect
    void refresh();
  }, [refresh]);

  const addAccount = async () => {
    setBusy(true);
    setError(null);
    try {
      await Effect.runPromise(backend.addAccount(undefined));
      await refresh();
    } catch (error) {
      setError(String(error));
    } finally {
      setBusy(false);
    }
  };

  const removeAccount = async (accountId: string) => {
    await Effect.runPromise(backend.removeAccount({ accountId }));
    await refresh();
  };

  const toggleCalendar = async (accountId: string, calendarId: string, isVisible: boolean) => {
    await Effect.runPromise(backend.setCalendarVisible({ accountId, calendarId, isVisible }));
    await refresh();
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Accounts</h1>
        <button
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50"
          disabled={busy}
          onClick={() => void addAccount()}
          type="button"
        >
          {busy ? 'Waiting for Google…' : 'Add Google Account'}
        </button>
      </header>

      {error ? (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm whitespace-pre-wrap text-red-700">
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
              <p className="font-medium">{account.displayName ?? account.email}</p>
              <p className="text-sm text-neutral-500">
                {account.email}
                {account.status === 'reauth_required' ? (
                  <button
                    className="ml-2 text-blue-600 hover:underline"
                    onClick={() => void addAccount()}
                    type="button"
                  >
                    Sign in again
                  </button>
                ) : null}
              </p>
            </div>
            <button
              className="text-sm text-red-600 hover:underline"
              onClick={() => void removeAccount(account.id)}
              type="button"
            >
              Remove
            </button>
          </div>
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
                      void toggleCalendar(
                        calendar.accountId,
                        calendar.id,
                        changeEvent.target.checked,
                      )
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
