import {
  useBackendMutations,
  useBirthdayReminderOverrides,
  useBirthdayReminderSettings,
  useLessonTried,
  useSettingsEditor,
} from '@calendar/app-state';
import {
  birthdayRemindersSummary,
  type BirthdayReminderSettings,
  DEVICE_ONLY_SETTING_COPY,
} from '@calendar/core';
import { useState } from 'react';
import { BirthdayReminderList } from './BirthdayReminderList.tsx';
import { TEXT_ACTION_CLASS } from './ui/buttonStyles.ts';

/**
 * Birthday notifications: the lead times, each at its own time of day.
 * Device-local by design (the first setting that does not sync), and the
 * copy says so. Every change saves through the backend mutation; the
 * atom refetch keeps the controls in step. Turning the reminders on asks
 * macOS for notification permission, and a denial stays visible as a
 * notice.
 */
export function BirthdayRemindersSection() {
  const { setBirthdayReminderOverride, setBirthdayReminderSettings } = useBackendMutations();
  const overrides = useBirthdayReminderOverrides() ?? [];
  const [settings, persist] = useSettingsEditor(
    useBirthdayReminderSettings(),
    setBirthdayReminderSettings,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const tried = useLessonTried();

  if (!settings) {
    return null;
  }
  const save = (next: Partial<BirthdayReminderSettings>) =>
    void persist(next).then(
      ({ notificationsGranted }) => {
        tried();
        setNotice(
          notificationsGranted
            ? null
            : 'Notifications are off — allow Solunivo in System Settings › Notifications.',
        );
      },
      (error: unknown) => setNotice(error instanceof Error ? error.message : String(error)),
    );
  return (
    <section className="rounded-popover bg-surface-subtle p-4">
      <h2 className="font-medium">Birthday reminders</h2>
      <p className="mt-1 text-sm text-ink-secondary">
        A notification for every contact birthday, at each time you pick.
      </p>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          aria-label="Remind me about birthdays"
          checked={settings.enabled}
          onChange={(change) => save({ enabled: change.target.checked })}
          type="checkbox"
        />
        Remind me about birthdays
      </label>
      <div className="mt-2">
        <BirthdayReminderList
          disabled={!settings.enabled}
          onChange={(reminders) => save({ reminders })}
          reminders={settings.reminders}
        />
      </div>
      {overrides.length > 0 ? (
        <div className="mt-3" data-testid="birthday-overrides">
          <p className="text-xs font-medium text-ink-secondary uppercase">Custom per person</p>
          <ul className="mt-1 flex flex-col gap-1">
            {overrides.map((override) => (
              <li
                className="flex items-center justify-between gap-2 text-sm"
                key={`${override.displayName}:${String(override.month)}-${String(override.day)}`}
              >
                {/* The list on a line of its own: with times it outgrows the row. */}
                <span className="min-w-0">
                  <span className="block truncate">{override.displayName}</span>
                  <span className="block text-xs text-ink-secondary">
                    {birthdayRemindersSummary(override.reminders)}
                  </span>
                </span>
                <button
                  aria-label={`Reset reminders for ${override.displayName}`}
                  className={`text-xs ${TEXT_ACTION_CLASS.primary}`}
                  onClick={() =>
                    void setBirthdayReminderOverride({ ...override, reminders: null }).catch(
                      (error: unknown) =>
                        setNotice(error instanceof Error ? error.message : String(error)),
                    )
                  }
                  type="button"
                >
                  Reset
                </button>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-ink-secondary">
            Change a person&apos;s reminders from their birthday in the calendar.
          </p>
        </div>
      ) : null}
      {notice ? (
        <p className="mt-3 text-sm text-warning" data-testid="birthday-notice" role="status">
          {notice}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-ink-secondary" data-testid="birthday-device-only">
        {DEVICE_ONLY_SETTING_COPY} Reminders arrive while Solunivo is running.
      </p>
    </section>
  );
}
