import {
  useBackendMutations,
  useBirthdayReminderOverrides,
  useBirthdayReminderSettings,
  useSettingsEditor,
} from '@calendar/app-state';
import {
  BIRTHDAY_LEAD_DAYS,
  DEVICE_ONLY_SETTING_COPY,
  type BirthdayLeadDays,
  type BirthdayReminderSettings,
  leadDaysLabel,
  leadDaysSummary,
} from '@calendar/core';
import { useState } from 'react';

/**
 * Lead times and delivery time for birthday notifications. Device-local
 * by design (the first setting that does not sync), and the copy says
 * so. Every change saves through the backend mutation; the atom refetch
 * keeps the controls in step. Turning the reminders on asks macOS for
 * notification permission, and a denial stays visible as a notice.
 */
export function BirthdayRemindersSection() {
  const { setBirthdayReminderOverride, setBirthdayReminderSettings } = useBackendMutations();
  const overrides = useBirthdayReminderOverrides() ?? [];
  const [settings, persist] = useSettingsEditor(
    useBirthdayReminderSettings(),
    setBirthdayReminderSettings,
  );
  const [notice, setNotice] = useState<string | null>(null);

  if (!settings) {
    return null;
  }
  const save = (next: Partial<BirthdayReminderSettings>) =>
    void persist(next).then(
      ({ notificationsGranted }) =>
        setNotice(
          notificationsGranted
            ? null
            : 'Notifications are off — allow Solunivo in System Settings › Notifications.',
        ),
      (error: unknown) => setNotice(error instanceof Error ? error.message : String(error)),
    );
  const toggleLead = (lead: BirthdayLeadDays, on: boolean) =>
    save({
      leadDays: on
        ? [...settings.leadDays, lead]
        : settings.leadDays.filter((value) => value !== lead),
    });

  return (
    <section className="rounded-popover bg-surface-subtle p-4">
      <h2 className="font-medium">Birthday reminders</h2>
      <p className="mt-1 text-sm text-ink-secondary">
        A notification for every contact birthday, at the lead times you pick.
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
      <fieldset className="mt-2 flex flex-col gap-1" disabled={!settings.enabled}>
        {BIRTHDAY_LEAD_DAYS.map((lead) => (
          <label className="flex items-center gap-2 text-sm disabled:opacity-50" key={lead}>
            <input
              aria-label={`Remind ${leadDaysLabel(lead).toLowerCase()}`}
              checked={settings.leadDays.includes(lead)}
              onChange={(change) => toggleLead(lead, change.target.checked)}
              type="checkbox"
            />
            {leadDaysLabel(lead)}
          </label>
        ))}
        <label className="mt-1 flex items-center gap-2 text-sm">
          at
          <input
            aria-label="Reminder time"
            className="rounded-lg border border-hairline bg-surface px-2 py-1 text-sm"
            onChange={(change) => change.target.value && save({ time: change.target.value })}
            type="time"
            value={settings.time}
          />
        </label>
      </fieldset>
      {overrides.length > 0 ? (
        <div className="mt-3" data-testid="birthday-overrides">
          <p className="text-xs font-medium text-ink-secondary uppercase">Custom per person</p>
          <ul className="mt-1 flex flex-col gap-1">
            {overrides.map((override) => (
              <li
                className="flex items-center justify-between gap-2 text-sm"
                key={`${override.displayName}:${String(override.month)}-${String(override.day)}`}
              >
                <span className="min-w-0 truncate">
                  {override.displayName}
                  <span className="text-ink-secondary">
                    {' '}
                    · {leadDaysSummary(override.leadDays)}
                  </span>
                </span>
                <button
                  aria-label={`Reset reminders for ${override.displayName}`}
                  className="rounded px-1.5 text-xs text-primary hover:bg-fill"
                  onClick={() =>
                    void setBirthdayReminderOverride({ ...override, leadDays: null }).catch(
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
