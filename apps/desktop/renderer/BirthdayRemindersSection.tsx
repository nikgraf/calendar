import { useBackendMutations, useBirthdayReminderSettings } from '@calendar/app-state';
import {
  BIRTHDAY_LEAD_DAYS,
  DEVICE_ONLY_SETTING_COPY,
  type BirthdayLeadDays,
  type BirthdayReminderSettings,
  leadDaysLabel,
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
  const settings = useBirthdayReminderSettings();
  const { setBirthdayReminderSettings } = useBackendMutations();
  const [notice, setNotice] = useState<string | null>(null);

  if (!settings) {
    return null;
  }
  const save = (next: Partial<BirthdayReminderSettings>) =>
    void setBirthdayReminderSettings({ ...settings, ...next }).then(
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
    <section className="rounded-xl border border-neutral-200 bg-white p-4">
      <h2 className="font-medium">Birthday reminders</h2>
      <p className="mt-1 text-sm text-neutral-500">
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
            className="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-sm"
            onChange={(change) => change.target.value && save({ time: change.target.value })}
            type="time"
            value={settings.time}
          />
        </label>
      </fieldset>
      {notice ? (
        <p className="mt-3 text-sm text-amber-700" data-testid="birthday-notice" role="status">
          {notice}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-neutral-400" data-testid="birthday-device-only">
        {DEVICE_ONLY_SETTING_COPY} Reminders arrive while Solunivo is running.
      </p>
    </section>
  );
}
