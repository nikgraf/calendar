import { type BirthdayOccurrence, describeBirthday, Temporal } from '@calendar/core';

const monthDay = (record: { readonly day: number; readonly month: number }): string =>
  Temporal.PlainMonthDay.from({ day: record.day, month: record.month }).toLocaleString('en-US', {
    day: 'numeric',
    month: 'long',
  });

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
 * The read-only half of the editor for a birthday: who, when, and where
 * it came from. Nothing to edit — birthdays live in Contacts and Google
 * Contacts; this view only names its sources so the user knows where.
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
      <p className="select-text text-sm text-neutral-700">
        🎂 {monthDay(record)}
        {record.year === undefined ? '' : ` · born ${String(record.year)}`}
      </p>
      <p className="text-sm text-neutral-500">{countdown(next.daysUntil, next.ageTurning)}</p>
      <div className="rounded-lg border border-neutral-200 bg-white p-3">
        <p className="mb-1 text-xs font-medium text-neutral-400 uppercase">Source</p>
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
      <p className="rounded-lg bg-neutral-100 p-2 text-sm text-neutral-600">
        Birthdays are read-only here — edit them in Contacts or Google Contacts.
      </p>
      <div className="mt-2 flex justify-end">
        <button
          className="rounded-lg px-3 py-1.5 text-sm hover:bg-neutral-200"
          onClick={onClose}
          type="button"
        >
          Close
        </button>
      </div>
    </div>
  );
}
