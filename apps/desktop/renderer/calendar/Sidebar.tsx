import type { Account, CalendarInfo } from '@calendar/core';
import { useBackendMutations } from '@calendar/app-state';

export function Sidebar({
  accounts,
  calendars,
  onOpenSettings,
}: {
  accounts: ReadonlyArray<Account>;
  calendars: ReadonlyArray<CalendarInfo>;
  onOpenSettings: () => void;
}) {
  const { setCalendarVisible } = useBackendMutations();

  const toggle = (calendar: CalendarInfo) => {
    void setCalendarVisible({
      accountId: calendar.accountId,
      calendarId: calendar.id,
      isVisible: !calendar.isVisible,
    });
  };

  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-neutral-200 bg-neutral-50">
      <div className="px-4 pt-10 pb-2 text-sm font-semibold">Calendar</div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2">
        {accounts.map((account) => (
          <section className="mb-3" key={account.id}>
            <p className="px-2 py-1 text-[11px] font-medium tracking-wide text-neutral-400 uppercase">
              {account.email}
              {account.status === 'reauth_required' ? ' — sign in again' : ''}
            </p>
            {calendars
              .filter((calendar) => calendar.accountId === account.id)
              .map((calendar) => (
                <button
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-sm hover:bg-neutral-200/60"
                  key={calendar.id}
                  onClick={() => toggle(calendar)}
                  type="button"
                >
                  <span
                    className="inline-flex size-3.5 shrink-0 items-center justify-center rounded"
                    style={{
                      backgroundColor: calendar.isVisible ? calendar.colorHex : 'transparent',
                      border: `2px solid ${calendar.colorHex}`,
                    }}
                  />
                  <span className={`truncate ${calendar.isVisible ? '' : 'text-neutral-400'}`}>
                    {calendar.summary}
                  </span>
                </button>
              ))}
          </section>
        ))}
        {accounts.length === 0 ? (
          <p className="px-2 py-4 text-sm text-neutral-400">No accounts connected.</p>
        ) : null}
      </div>
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
