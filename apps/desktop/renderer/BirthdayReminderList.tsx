import {
  addBirthdayReminder,
  BIRTHDAY_LEAD_DAYS,
  type BirthdayReminder,
  leadDaysLabel,
  removeBirthdayReminder,
  setBirthdayReminderTime,
} from '@calendar/core';

/**
 * Birthday reminders as the lead times to pick from, each a checkbox; a
 * checked one shows its own time of day beside it. Shared by Settings
 * (everyone) and the birthday detail (one person). A lead checked anew
 * starts at the time of the nearest one already there.
 */
export function BirthdayReminderList({
  disabled = false,
  onChange,
  reminders,
}: {
  disabled?: boolean;
  onChange: (reminders: ReadonlyArray<BirthdayReminder>) => void;
  reminders: ReadonlyArray<BirthdayReminder>;
}) {
  return (
    <fieldset className="flex flex-col gap-1" disabled={disabled}>
      {BIRTHDAY_LEAD_DAYS.map((lead) => {
        const label = leadDaysLabel(lead);
        const reminder = reminders.find((candidate) => candidate.leadDays === lead);
        return (
          // A fixed height: the time field coming and going does not move the rows.
          <div className="flex h-8 items-center gap-2 text-sm" key={lead}>
            <label className="flex w-36 shrink-0 items-center gap-2">
              <input
                aria-label={`Remind ${label.toLowerCase()}`}
                checked={reminder !== undefined}
                onChange={(change) =>
                  onChange(
                    change.target.checked
                      ? addBirthdayReminder(reminders, lead)
                      : removeBirthdayReminder(reminders, lead),
                  )
                }
                type="checkbox"
              />
              {label}
            </label>
            {reminder ? (
              <label className="flex items-center gap-2 text-ink-secondary">
                at
                <input
                  aria-label={`Time ${label.toLowerCase()}`}
                  className="rounded-lg border border-hairline bg-surface px-2 py-0.5 text-sm text-ink"
                  onChange={(change) =>
                    change.target.value &&
                    onChange(setBirthdayReminderTime(reminders, lead, change.target.value))
                  }
                  type="time"
                  value={reminder.time}
                />
              </label>
            ) : null}
          </div>
        );
      })}
    </fieldset>
  );
}
