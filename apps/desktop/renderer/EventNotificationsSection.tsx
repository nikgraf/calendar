import {
  useBackendMutations,
  useEventNotificationSettings,
  useSettingsEditor,
} from '@calendar/app-state';
import { DEVICE_ONLY_SETTING_COPY, type EventNotificationSettings } from '@calendar/core';
import { useState } from 'react';

/**
 * Whether event reminders notify on this Mac, and whether Apple Calendar
 * events count too (Calendar.app already notifies for those, so that
 * one is off unless asked). Device-local like the birthday reminders;
 * turning it on posts the permission banner, a denial stays as a notice.
 */
export function EventNotificationsSection() {
  const { setEventNotificationSettings } = useBackendMutations();
  const [settings, persist] = useSettingsEditor(
    useEventNotificationSettings(),
    setEventNotificationSettings,
  );
  const [notice, setNotice] = useState<string | null>(null);

  if (!settings) {
    return null;
  }
  const save = (next: Partial<EventNotificationSettings>) =>
    void persist(next).then(
      ({ notificationsGranted }) =>
        setNotice(
          notificationsGranted
            ? null
            : 'Notifications are off — allow Solunivo in System Settings › Notifications.',
        ),
      (error: unknown) => setNotice(error instanceof Error ? error.message : String(error)),
    );

  return (
    <section className="rounded-popover bg-surface-subtle p-4">
      <h2 className="font-medium">Event notifications</h2>
      <p className="mt-1 text-sm text-ink-secondary">
        A notification before each event, at the times set on the event or its calendar.
      </p>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          aria-label="Notify me before events"
          checked={settings.enabled}
          onChange={(change) => save({ enabled: change.target.checked })}
          type="checkbox"
        />
        Notify me before events
      </label>
      <label className="mt-2 flex items-center gap-2 text-sm">
        <input
          aria-label="Also for Apple Calendar events"
          checked={settings.includeAppleCalendar}
          disabled={!settings.enabled}
          onChange={(change) => save({ includeAppleCalendar: change.target.checked })}
          type="checkbox"
        />
        Also for Apple Calendar events
      </label>
      <p className="mt-1 ml-6 text-xs text-ink-secondary">
        Calendar already notifies you about these; on means you get both.
      </p>
      {notice ? (
        <p className="mt-3 text-sm text-warning" data-testid="event-notice" role="status">
          {notice}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-ink-secondary" data-testid="event-notifications-device-only">
        {DEVICE_ONLY_SETTING_COPY} Notifications arrive while Solunivo is running.
      </p>
    </section>
  );
}
