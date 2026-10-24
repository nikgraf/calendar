import {
  addBirthdayReminder,
  BIRTHDAY_LEAD_DAYS,
  type BirthdayReminder,
  leadDaysLabel,
  removeBirthdayReminder,
  setBirthdayReminderTime,
} from '@calendar/core';
import { useEffect, useRef, useState } from 'react';

/** How long typing in a time field pauses before the time is saved. */
const TIME_COMMIT_MS = 600;

/**
 * A reminder's time field that saves once typing pauses, or as it loses
 * focus. Every keystroke is a whole time to the field ("1" of "19" reads
 * 01:00), and saving each one re-planned at it: for a birthday today, a
 * passed time fires at once, and the time typed after it has the same
 * notification key, so it never fires. The save runs through the latest
 * `onCommit`, never one from the keystroke's render, which would undo a
 * box ticked meanwhile.
 */
function ReminderTimeInput({
  label,
  onCommit,
  value,
}: {
  label: string;
  onCommit: (time: string) => void;
  value: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const commitRef = useRef(onCommit);
  useEffect(() => {
    commitRef.current = onCommit;
  }, [onCommit]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flush = (time: string | null) => {
    clearTimeout(timer.current);
    timer.current = undefined;
    setDraft(null);
    if (time !== null) {
      commitRef.current(time);
    }
  };
  return (
    <input
      aria-label={label}
      className="rounded-lg border border-hairline bg-surface px-2 py-0.5 text-sm text-ink"
      onBlur={() => flush(draft)}
      onChange={(change) => {
        const time = change.target.value;
        if (!time) {
          return;
        }
        setDraft(time);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => flush(time), TIME_COMMIT_MS);
      }}
      type="time"
      value={draft ?? value}
    />
  );
}

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
                <ReminderTimeInput
                  label={`Time ${label.toLowerCase()}`}
                  onCommit={(time) => onChange(setBirthdayReminderTime(reminders, lead, time))}
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
