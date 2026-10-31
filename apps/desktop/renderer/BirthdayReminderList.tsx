import {
  addBirthdayReminder,
  BIRTHDAY_LEAD_DAYS,
  type BirthdayReminder,
  leadDaysLabel,
  removeBirthdayReminder,
  setBirthdayReminderTime,
} from '@calendar/core';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * A reminder's time field that saves when it is done with — on blur or
 * Enter, or as it goes away (the dialog closed with Escape, the window
 * closed), never per keystroke. Every keystroke is a whole time to the
 * field ("1" of "19" reads 01:00; a 12-hour clock reads AM until the
 * last segment), and a saved time re-plans at once: for a birthday today
 * a passed time fires straight away, and the time meant after it has the
 * same notification key, so it never fires. `onCommit` applies the time
 * to the list as last drawn (see `BirthdayReminderList`).
 */
export function ReminderTimeInput({
  label,
  onCommit,
  value,
}: {
  label: string;
  onCommit: (time: string) => Promise<void>;
  value: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  // The typed time not yet saved, for the cleanup and beforeunload, which
  // would read a stale `draft`.
  const pending = useRef<string | null>(null);
  const commitRef = useRef(onCommit);
  useEffect(() => {
    commitRef.current = onCommit;
  }, [onCommit]);
  useEffect(() => {
    // Neither an unmount (Escape closing the dialog) nor a closing window
    // blurs the field first. A window closing waits for the save: its rpc
    // client goes with it and would cut an unfinished save off. Electron
    // cancels a close that beforeunload marks, without asking.
    const holdClose = (event: BeforeUnloadEvent) => {
      const time = pending.current;
      if (time === null) {
        return;
      }
      pending.current = null;
      event.preventDefault();
      event.returnValue = false;
      void commitRef.current(time).finally(() => window.close());
    };
    window.addEventListener('beforeunload', holdClose);
    return () => {
      window.removeEventListener('beforeunload', holdClose);
      const time = pending.current;
      pending.current = null;
      if (time !== null) {
        void commitRef.current(time);
      }
    };
  }, []);
  const commit = () => {
    const time = pending.current;
    pending.current = null;
    setDraft(null);
    if (time !== null) {
      void commitRef.current(time);
    }
  };
  return (
    <input
      aria-label={label}
      className="rounded-lg border border-hairline bg-surface px-2 py-0.5 text-sm text-ink"
      onBlur={commit}
      onChange={(change) => {
        const time = change.target.value;
        if (time) {
          pending.current = time;
          setDraft(time);
        }
      }}
      onKeyDown={(key) => {
        if (key.key === 'Enter') {
          commit();
        }
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
  /** Saves the list; a time field closing its window waits for the promise. */
  onChange: (reminders: ReadonlyArray<BirthdayReminder>) => Promise<unknown> | void;
  reminders: ReadonlyArray<BirthdayReminder>;
}) {
  // The list as last drawn, for a time field saving late (left, or going
  // away). By then a change from elsewhere may have replaced the list — a
  // reset in Settings, an import — and the one from the field's own
  // render would bring it back; a lead no longer there drops the time.
  // Synced in a layout effect: a removed field's unmount runs after it.
  const latest = useRef({ onChange, reminders });
  useLayoutEffect(() => {
    latest.current = { onChange, reminders };
  });
  // A time already there saves nothing: for a person on the general
  // reminders, a save would give them their own list.
  const commitTime = async (lead: BirthdayReminder['leadDays'], time: string) => {
    const current = latest.current;
    const reminder = current.reminders.find((candidate) => candidate.leadDays === lead);
    if (reminder && reminder.time !== time) {
      await current.onChange(setBirthdayReminderTime(current.reminders, lead, time));
    }
  };
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
                  onCommit={(time) => commitTime(lead, time)}
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
