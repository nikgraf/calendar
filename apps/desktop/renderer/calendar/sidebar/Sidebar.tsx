import type { Account, CalendarInfo, Temporal } from '@calendar/core';
import { CalendarList } from './CalendarList.tsx';
import { MiniMonth } from './MiniMonth.tsx';
import { SyncFooter } from './SyncFooter.tsx';

/** The left column: a month at a glance, the calendars and lists, and sync. */
export function Sidebar({
  accounts,
  calendars,
  focused,
  onManageAccounts,
  onPickDay,
  today,
  visible,
}: {
  accounts: ReadonlyArray<Account>;
  calendars: ReadonlyArray<CalendarInfo>;
  focused: Temporal.PlainDate;
  onManageAccounts: () => void;
  onPickDay: (date: Temporal.PlainDate) => void;
  today: Temporal.PlainDate;
  /** The main view's first and last day, highlighted in the month; null in the month view. */
  visible: { readonly end: Temporal.PlainDate; readonly start: Temporal.PlainDate } | null;
}) {
  return (
    <aside
      className="flex w-58 shrink-0 flex-col border-r border-hairline bg-surface-subtle"
      data-testid="sidebar"
    >
      <MiniMonth
        focused={focused}
        key={`${String(focused.year)}-${String(focused.month)}`}
        onPick={onPickDay}
        today={today}
        visible={visible}
      />
      <CalendarList accounts={accounts} calendars={calendars} />
      <SyncFooter onManageAccounts={onManageAccounts} />
    </aside>
  );
}
