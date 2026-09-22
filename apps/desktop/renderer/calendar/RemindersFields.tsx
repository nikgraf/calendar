import type { useEventEditorModel } from '@calendar/app-state';
import {
  ALL_DAY_REMINDER_PRESET_MINUTES,
  MAX_REMINDER_OVERRIDES,
  REMINDER_PRESET_MINUTES,
  reminderLabel,
} from '@calendar/core';
import { FIELD_CLASS as field } from './fieldStyles.ts';

/**
 * The event's reminders. Google: a "calendar default" checkbox (what it
 * stands for in the caption) or explicit rows; Apple: rows only, since
 * EventKit alarms are always explicit. Email reminders set elsewhere are
 * shown, never edited — they ride along on the write-back. A read-only
 * event lists what it has.
 */
export function RemindersFields({ model }: { model: ReturnType<typeof useEventEditorModel> }) {
  const {
    addReminder,
    calendarDefaultReminders,
    canUseDefaultReminders,
    isAllDay,
    readOnly,
    reminders,
    removeReminder,
    setReminderMinutes,
    setUseDefaultReminders,
  } = model;
  const presets = isAllDay ? ALL_DAY_REMINDER_PRESET_MINUTES : REMINDER_PRESET_MINUTES;
  const options = (current: number) =>
    [...new Set<number>([...presets, current])].sort((a, b) => a - b);
  const defaultCaption =
    calendarDefaultReminders.length === 0
      ? 'none'
      : calendarDefaultReminders
          .map((minutes) => reminderLabel(minutes, isAllDay).toLowerCase())
          .join(', ');
  const useDefault = canUseDefaultReminders && reminders.useDefault;
  const full = reminders.overrides.length >= MAX_REMINDER_OVERRIDES;

  if (readOnly) {
    const listed = useDefault
      ? calendarDefaultReminders.map((minutes) => reminderLabel(minutes, isAllDay))
      : reminders.overrides.map(
          (override) =>
            `${override.method === 'email' ? 'Email · ' : ''}${reminderLabel(override.minutes, isAllDay)}`,
        );
    return (
      <div
        className="rounded-lg border border-neutral-200 bg-white p-3"
        data-testid="event-reminders"
      >
        <p className="mb-1 text-xs font-medium text-neutral-400 uppercase">Notifications</p>
        <ul className="text-sm text-neutral-700">
          {listed.length === 0 ? <li className="text-neutral-400">None</li> : null}
          {listed.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
      </div>
    );
  }

  return (
    <div
      className="rounded-lg border border-neutral-200 bg-white p-3"
      data-testid="event-reminders"
    >
      <p className="mb-1 text-xs font-medium text-neutral-400 uppercase">Notifications</p>
      {canUseDefaultReminders ? (
        <label className="mb-2 flex items-center gap-2 text-sm">
          <input
            aria-label="Use calendar default"
            checked={reminders.useDefault}
            onChange={(change) => setUseDefaultReminders(change.target.checked)}
            type="checkbox"
          />
          Use calendar default ({defaultCaption})
        </label>
      ) : null}
      {useDefault ? null : (
        <div className="flex flex-col gap-1">
          {reminders.overrides.map((override, index) =>
            override.method === 'email' ? (
              <p className="text-sm text-neutral-500" key={`email-${String(index)}`}>
                Email · {reminderLabel(override.minutes, isAllDay)}
              </p>
            ) : (
              <div className="flex items-center gap-2" key={`popup-${String(index)}`}>
                <select
                  aria-label={`Notification ${String(index + 1)}`}
                  className={field}
                  data-testid={`event-reminder-${String(index)}`}
                  onChange={(change) => setReminderMinutes(index, Number(change.target.value))}
                  value={override.minutes}
                >
                  {options(override.minutes).map((minutes) => (
                    <option key={minutes} value={minutes}>
                      {reminderLabel(minutes, isAllDay)}
                    </option>
                  ))}
                </select>
                <button
                  aria-label={`Remove notification ${String(index + 1)}`}
                  className="text-sm text-neutral-500 hover:text-red-600"
                  onClick={() => removeReminder(index)}
                  type="button"
                >
                  ✕
                </button>
              </div>
            ),
          )}
          {reminders.overrides.length === 0 ? (
            <p className="text-sm text-neutral-400">None</p>
          ) : null}
          <button
            className="self-start text-sm text-blue-600 hover:underline disabled:text-neutral-400"
            data-testid="event-reminder-add"
            disabled={full}
            onClick={() => addReminder(presets[isAllDay ? 2 : 1] ?? 10)}
            title={full ? `At most ${String(MAX_REMINDER_OVERRIDES)} notifications` : undefined}
            type="button"
          >
            Add notification
          </button>
        </div>
      )}
    </div>
  );
}
