import type { Account, CalendarInfo, TaskListInfo } from '@calendar/core';
import { useGuardedMutations, useTaskLists } from '@calendar/app-state';
import { CalendarColorButton } from './CalendarColorButton.tsx';
import { SyncStatus } from './SyncStatus.tsx';

export function Sidebar({
  accounts,
  calendars,
  onOpenSettings,
}: {
  accounts: ReadonlyArray<Account>;
  calendars: ReadonlyArray<CalendarInfo>;
  onOpenSettings: () => void;
}) {
  const { addAccount, connectReminders, setCalendarVisible, setTaskListVisible } =
    useGuardedMutations();
  const taskLists = useTaskLists();

  const toggleList = (list: TaskListInfo) => {
    void setTaskListVisible({
      accountId: list.accountId,
      isVisible: !list.isVisible,
      taskListId: list.id,
    });
  };

  const toggle = (calendar: CalendarInfo) => {
    void setCalendarVisible({
      accountId: calendar.accountId,
      calendarId: calendar.id,
      isVisible: !calendar.isVisible,
    });
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50">
      <div className="px-4 pt-10 pb-2 text-sm font-semibold">Solunivo</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {accounts.map((account) => (
          <section className="mb-3" key={account.id}>
            <p className="select-text px-2 py-1 text-[11px] font-medium tracking-wide text-neutral-400 uppercase">
              {account.provider === 'apple' ? 'Apple Reminders' : account.email}
              {account.status === 'reauth_required' ? (
                <span className="text-amber-600">
                  {account.provider === 'apple' ? ' — access off' : ' — sign in again'}
                </span>
              ) : null}
            </p>
            {calendars
              .filter((calendar) => calendar.accountId === account.id)
              .map((calendar) => (
                <div
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 hover:bg-neutral-200/60"
                  key={calendar.id}
                >
                  <CalendarColorButton calendar={calendar} />
                  <button
                    className="min-w-0 flex-1 text-left text-sm"
                    onClick={() => toggle(calendar)}
                    type="button"
                  >
                    <span
                      className={`block truncate ${calendar.isVisible ? '' : 'text-neutral-400'}`}
                    >
                      {calendar.summary}
                    </span>
                  </button>
                </div>
              ))}
            {taskLists
              .filter((list) => list.accountId === account.id)
              .map((list) => (
                <button
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-neutral-200/60"
                  key={list.id}
                  onClick={() => toggleList(list)}
                  type="button"
                >
                  {list.colorHex ? (
                    <span
                      aria-hidden
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: list.colorHex }}
                    />
                  ) : (
                    <span aria-hidden className="text-xs">
                      ✓
                    </span>
                  )}
                  <span className={`block truncate ${list.isVisible ? '' : 'text-neutral-400'}`}>
                    {list.title}
                  </span>
                </button>
              ))}
            {account.provider === 'apple' && account.status === 'reauth_required' ? (
              <p className="px-2 py-1 text-xs text-neutral-400">
                Allow Reminders in System Settings › Privacy & Security — it reconnects on its own.
              </p>
            ) : null}
            {account.tasksEnabled || account.provider !== 'google' ? null : (
              // Tokens from before the tasks scope: re-running sign-in
              // re-consents and upgrades the account in place.
              <button
                className="w-full rounded-md px-2 py-1 text-left text-xs text-neutral-400 hover:bg-neutral-200/60 hover:text-neutral-600"
                onClick={() => void addAccount(undefined)}
                type="button"
              >
                Connect Google Tasks — sign in again
              </button>
            )}
          </section>
        ))}
        {accounts.length === 0 ? (
          <p className="px-2 py-4 text-sm text-neutral-400">No accounts connected.</p>
        ) : null}
        {accounts.some((account) => account.provider === 'apple') ? null : (
          <button
            className="w-full rounded-md px-2 py-1 text-left text-xs text-neutral-400 hover:bg-neutral-200/60 hover:text-neutral-600"
            onClick={() => void connectReminders(undefined)}
            type="button"
          >
            Connect Apple Reminders
          </button>
        )}
      </div>
      <SyncStatus />
      <button
        className="m-3 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-sm hover:bg-neutral-100"
        onClick={onOpenSettings}
        type="button"
      >
        Manage accounts…
      </button>
    </aside>
  );
}
