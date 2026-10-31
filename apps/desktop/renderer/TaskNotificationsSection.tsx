import {
  useBackendMutations,
  useLessonTried,
  useSettingsEditor,
  useTaskNotificationSettings,
} from '@calendar/app-state';
import { DEVICE_ONLY_SETTING_COPY, type TaskNotificationSettings } from '@calendar/core';
import { useState } from 'react';
import { ReminderTimeInput } from './BirthdayReminderList.tsx';

/**
 * Whether tasks notify on this Mac — on the day a task is due, at the
 * time set here; a reminder with a time of its own at that time — and
 * whether Apple Reminders count too (the Reminders app already notifies
 * for ones with an alert). Device-local like the event ones; turning it
 * on posts the permission banner, a denial stays as a notice. No "remove
 * when done" here: the Mac never removes a notification it showed, so it
 * stores no such value (one comes only from an import).
 */
export function TaskNotificationsSection() {
  const { setTaskNotificationSettings } = useBackendMutations();
  const [settings, persist] = useSettingsEditor(
    useTaskNotificationSettings(),
    setTaskNotificationSettings,
  );
  const [notice, setNotice] = useState<string | null>(null);
  const tried = useLessonTried();

  if (!settings) {
    return null;
  }
  const save = (next: Partial<TaskNotificationSettings>): Promise<void> =>
    persist(next).then(
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
      <h2 className="font-medium">Task notifications</h2>
      <p className="mt-1 text-sm text-ink-secondary">
        A notification on the day a task is due; a reminder with a time of its own notifies at that
        time.
      </p>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input
          aria-label="Notify me about tasks"
          checked={settings.enabled}
          onChange={(change) => void save({ enabled: change.target.checked })}
          type="checkbox"
        />
        Notify me about tasks
      </label>
      <fieldset
        className="mt-2 ml-6 flex items-center gap-2 text-sm disabled:opacity-60"
        disabled={!settings.enabled}
      >
        <span>at</span>
        <ReminderTimeInput
          label="Task notification time"
          onCommit={(time) => save({ time })}
          value={settings.time}
        />
        <span className="text-xs text-ink-secondary">for tasks without a time of their own</span>
      </fieldset>
      <label className="mt-2 flex items-center gap-2 text-sm">
        <input
          aria-label="Also for Apple Reminders"
          checked={settings.includeAppleReminders}
          disabled={!settings.enabled}
          onChange={(change) => void save({ includeAppleReminders: change.target.checked })}
          type="checkbox"
        />
        Also for Apple Reminders
      </label>
      <p className="mt-1 ml-6 text-xs text-ink-secondary">
        Reminders already notifies you about reminders with an alert; on means you get both.
      </p>
      {notice ? (
        <p className="mt-3 text-sm text-warning" data-testid="task-notice" role="status">
          {notice}
        </p>
      ) : null}
      <p className="mt-3 text-xs text-ink-secondary" data-testid="task-notifications-device-only">
        {DEVICE_ONLY_SETTING_COPY} Notifications arrive while Solunivo is running.
      </p>
    </section>
  );
}
