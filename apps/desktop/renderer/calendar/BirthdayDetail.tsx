import { useBirthdayOverrideEditor } from '@calendar/app-state';
import {
  BIRTHDAY_LEAD_DAYS,
  type BirthdayOccurrence,
  type BirthdayRecord,
  describeBirthday,
  leadDaysLabel,
  Temporal,
} from '@calendar/core';
import { useState } from 'react';

// Through a PlainDate in a leap year: the polyfill cannot localise a
// PlainMonthDay ("cannot format PlainMonthDay with calendar iso8601"),
// and 2000 keeps Feb 29 formattable.
const monthDay = (record: { readonly day: number; readonly month: number }): string =>
  Temporal.PlainDate.from({ day: record.day, month: record.month, year: 2000 }).toLocaleString(
    'en-US',
    { day: 'numeric', month: 'long' },
  );

const countdown = (daysUntil: number, ageTurning: number | undefined): string => {
  const turns = ageTurning === undefined ? '' : ` — turns ${String(ageTurning)}`;
  if (daysUntil === 0) {
    return `Today${turns}`;
  }
  if (daysUntil === 1) {
    return `Tomorrow${turns}`;
  }
  return `In ${String(daysUntil)} days${turns}`;
};

/**
 * This person's reminder lead days: the general ones until a box is
 * changed, then their own (saved at once, no Save button). "Use defaults"
 * hands them back to the general list.
 */
function BirthdayReminders({ record }: { record: BirthdayRecord }) {
  const editor = useBirthdayOverrideEditor(record);
  const [error, setError] = useState<string | null>(null);
  if (!editor.loaded) {
    return null;
  }
  const run = (save: Promise<void>) =>
    void save.then(
      () => setError(null),
      (error: unknown) => setError(error instanceof Error ? error.message : String(error)),
    );
  return (
    <div
      className="rounded-lg border border-hairline bg-surface p-3"
      data-testid="birthday-reminders"
    >
      <div className="mb-1 flex items-center justify-between">
        <p className="text-xs font-medium text-ink-secondary uppercase">Reminders</p>
        {editor.overridden ? (
          <button
            className="rounded px-1.5 text-xs text-primary hover:bg-fill"
            data-testid="birthday-reminders-custom"
            onClick={() => run(editor.reset())}
            type="button"
          >
            Use defaults
          </button>
        ) : null}
      </div>
      <div className="flex flex-col gap-1">
        {BIRTHDAY_LEAD_DAYS.map((lead) => (
          <label className="flex items-center gap-2 text-sm" key={lead}>
            <input
              aria-label={`Remind ${leadDaysLabel(lead).toLowerCase()}`}
              checked={editor.leadDays.includes(lead)}
              onChange={() => run(editor.toggle(lead))}
              type="checkbox"
            />
            {leadDaysLabel(lead)}
          </label>
        ))}
      </div>
      {editor.enabled ? null : (
        <p className="mt-2 text-xs text-ink-secondary" data-testid="birthday-reminders-off">
          Birthday reminders are off — turn them on in Settings › Notifications.
        </p>
      )}
      {error ? (
        <p className="mt-2 text-xs text-warning" role="status">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The editor for a birthday: who, when, and where it came from, plus this
 * person's reminder lead days. The birthday itself is read-only —
 * birthdays live in Contacts and Google Contacts; this view only names
 * its sources so the user knows where.
 */
export function BirthdayDetail({
  occurrence,
  onClose,
  timeZone,
}: {
  occurrence: BirthdayOccurrence;
  onClose: () => void;
  timeZone: string;
}) {
  const { record } = occurrence;
  const next = describeBirthday(record, Temporal.Now.plainDateISO(timeZone).toString());
  return (
    <div className="flex flex-col gap-3" data-testid="birthday-detail">
      <p className="select-text text-base font-medium">{record.displayName}</p>
      <p className="select-text text-sm text-ink-secondary">
        🎂 {monthDay(record)}
        {record.year === undefined ? '' : ` · born ${String(record.year)}`}
      </p>
      <p className="text-sm text-ink-secondary">{countdown(next.daysUntil, next.ageTurning)}</p>
      <div className="rounded-lg border border-hairline bg-surface p-3">
        <p className="mb-1 text-xs font-medium text-ink-secondary uppercase">Source</p>
        <ul className="flex flex-col gap-1 text-sm">
          {record.sources.map((source) => (
            <li className="select-text" data-testid="birthday-source" key={source.id}>
              {source.source === 'google'
                ? `Google contact${source.accountEmail ? ` · ${source.accountEmail}` : ''}`
                : 'Device contact (this Mac)'}
            </li>
          ))}
        </ul>
      </div>
      <BirthdayReminders record={record} />
      <p className="rounded-lg bg-fill p-2 text-sm text-ink-secondary">
        Birthdays are read-only here — edit them in Contacts or Google Contacts.
      </p>
      <div className="mt-2 flex justify-end">
        <button
          className="rounded-lg px-3 py-1.5 text-sm hover:bg-fill"
          onClick={onClose}
          type="button"
        >
          Close
        </button>
      </div>
    </div>
  );
}
