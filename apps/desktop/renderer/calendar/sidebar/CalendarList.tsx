import { useBackendMutations, useGuardedMutations, useTaskLists } from '@calendar/app-state';
import {
  type Account,
  type CalendarInfo,
  isAppleCalendarAccount,
  isAppleRemindersAccount,
  type TaskListInfo,
} from '@calendar/core';
import { useState } from 'react';
import { CalendarColorButton } from '../CalendarColorButton.tsx';

const quietButton =
  'w-full rounded-control px-2 py-1 text-left text-xs text-ink-secondary hover:bg-fill hover:text-ink';

/**
 * The sidebar's calendars and task lists, per account (Apple calendars
 * per EventKit source): the name toggles visibility, the swatch opens the
 * color picker. Connect and re-sign-in actions sit with the account they
 * concern.
 */
export function CalendarList({
  accounts,
  calendars,
}: {
  accounts: ReadonlyArray<Account>;
  calendars: ReadonlyArray<CalendarInfo>;
}) {
  const { addAccount, setCalendarVisible, setTaskListVisible } = useGuardedMutations();
  // Raw, not guarded: a refused grant resolves (granted: false) rather than
  // rejecting, and the user needs to hear about it.
  const { connectAppleCalendar, connectReminders } = useBackendMutations();
  const [connectNote, setConnectNote] = useState<string | null>(null);
  const taskLists = useTaskLists();

  const connect = async (what: 'calendar' | 'reminders') => {
    setConnectNote(null);
    try {
      const result = await (what === 'calendar' ? connectAppleCalendar : connectReminders)(
        undefined,
      );
      if (!result.granted) {
        setConnectNote(
          what === 'calendar'
            ? 'Calendar access was not granted — allow it in System Settings › Privacy & Security › Calendars.'
            : 'Reminders access was not granted — allow it in System Settings › Privacy & Security › Reminders.',
        );
      }
    } catch (error) {
      setConnectNote(String(error));
    }
  };

  const toggle = (calendar: CalendarInfo) =>
    void setCalendarVisible({
      accountId: calendar.accountId,
      calendarId: calendar.id,
      isVisible: !calendar.isVisible,
    });
  const toggleList = (list: TaskListInfo) =>
    void setTaskListVisible({
      accountId: list.accountId,
      isVisible: !list.isVisible,
      taskListId: list.id,
    });

  const calendarRow = (calendar: CalendarInfo) => (
    <div
      className="flex h-6.5 w-full items-center gap-2 rounded-control px-2 hover:bg-fill"
      data-testid={`sidebar-calendar-${calendar.id}`}
      key={calendar.id}
    >
      <CalendarColorButton calendar={calendar} />
      <button
        aria-pressed={calendar.isVisible}
        className="min-w-0 flex-1 text-left text-sm"
        onClick={() => toggle(calendar)}
        type="button"
      >
        <span className={`block truncate ${calendar.isVisible ? '' : 'text-ink-secondary'}`}>
          {calendar.summary}
        </span>
      </button>
    </div>
  );

  /** Apple Calendar lists its calendars per EventKit source (iCloud, On My Mac…). */
  const appleSources = (accountCalendars: ReadonlyArray<CalendarInfo>) => {
    const sources = new Map<string, Array<CalendarInfo>>();
    for (const calendar of accountCalendars) {
      const source = calendar.sourceTitle || 'On My Mac';
      sources.set(source, [...(sources.get(source) ?? []), calendar]);
    }
    return [...sources].map(([source, entries]) => (
      <div data-testid={`calendar-source-${source}`} key={source}>
        <p className="px-2 pt-1 text-[11px] text-ink-secondary">{source}</p>
        {entries.map(calendarRow)}
      </div>
    ));
  };

  const listRow = (list: TaskListInfo) => (
    <button
      aria-pressed={list.isVisible}
      className="flex h-6.5 w-full items-center gap-2 rounded-control px-2 text-left text-sm hover:bg-fill"
      data-testid={`sidebar-list-${list.id}`}
      key={list.id}
      onClick={() => toggleList(list)}
      type="button"
    >
      <span
        aria-hidden
        className="size-3.5 shrink-0 rounded-full"
        style={{
          backgroundColor: list.isVisible
            ? (list.colorHex ?? 'var(--border-strong)')
            : 'transparent',
          border: `2px solid ${list.colorHex ?? 'var(--border-strong)'}`,
        }}
      />
      <span className={`block truncate ${list.isVisible ? '' : 'text-ink-secondary'}`}>
        {list.title}
      </span>
    </button>
  );

  const lists = (account: Account) => taskLists.filter((list) => list.accountId === account.id);

  return (
    <nav aria-label="Calendars and task lists" className="min-h-0 flex-1 overflow-y-auto px-2">
      {accounts.map((account) => (
        <section className="mb-3" key={account.id}>
          <p className="flex items-center gap-1 px-2 py-1 text-[11px] font-medium text-ink-secondary">
            <span className="min-w-0 truncate select-text">
              {isAppleRemindersAccount(account)
                ? 'Apple Reminders'
                : isAppleCalendarAccount(account)
                  ? 'Apple Calendar'
                  : account.email}
            </span>
            {account.status === 'reauth_required' ? (
              <span className="shrink-0 text-warning">
                {account.provider === 'apple' ? '— access off' : '— sign in again'}
              </span>
            ) : null}
          </p>
          {isAppleCalendarAccount(account)
            ? appleSources(calendars.filter((calendar) => calendar.accountId === account.id))
            : calendars.filter((calendar) => calendar.accountId === account.id).map(calendarRow)}
          {lists(account).length > 0 ? (
            <div className={isAppleRemindersAccount(account) ? '' : 'mt-1'}>
              {lists(account).map(listRow)}
            </div>
          ) : null}
          {account.provider === 'apple' && account.status === 'reauth_required' ? (
            <p className="px-2 py-1 text-xs text-ink-secondary">
              Allow {isAppleCalendarAccount(account) ? 'Calendars' : 'Reminders'} in System Settings
              › Privacy & Security — it reconnects on its own.
            </p>
          ) : null}
          {account.tasksEnabled || account.provider !== 'google' ? null : (
            // Tokens from before the tasks scope: re-running sign-in
            // re-consents and upgrades the account in place.
            <button
              className={quietButton}
              onClick={() => void addAccount({ loginHint: account.email })}
              type="button"
            >
              Connect Google Tasks — sign in again
            </button>
          )}
        </section>
      ))}
      {accounts.length === 0 ? (
        <p className="px-2 py-4 text-sm text-ink-secondary">No accounts connected.</p>
      ) : null}
      {accounts.some(isAppleCalendarAccount) ? null : (
        <button className={quietButton} onClick={() => void connect('calendar')} type="button">
          Connect Apple Calendar
        </button>
      )}
      {accounts.some(isAppleRemindersAccount) ? null : (
        <button className={quietButton} onClick={() => void connect('reminders')} type="button">
          Connect Apple Reminders
        </button>
      )}
      {connectNote ? <p className="px-2 py-1 text-xs text-warning">{connectNote}</p> : null}
    </nav>
  );
}
