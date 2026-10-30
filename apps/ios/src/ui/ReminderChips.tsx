import type { useEventEditorModel } from '@calendar/app-state';
import {
  ALL_DAY_REMINDER_PRESET_MINUTES,
  MAX_REMINDER_OVERRIDES,
  REMINDER_PRESET_MINUTES,
  reminderLabel,
} from '@calendar/core';
import { Chip } from './Chip.tsx';
import { FieldFlash } from './FlashView.tsx';
import { ChipsRow, Row, Section, SwitchRow } from './GroupedList.tsx';

/**
 * The event's notifications as one card: a "Calendar default" switch
 * (Google events; Apple events never can, EventKit alarms being
 * explicit), then one chip per preset offset (an offset set elsewhere
 * joins the row selected). Email reminders are listed, not edited, and
 * ride along on the write-back.
 */
export function ReminderChips({ model }: { model: ReturnType<typeof useEventEditorModel> }) {
  const {
    addReminder,
    calendarDefaultReminders,
    canUseDefaultReminders,
    isAllDay,
    readOnly,
    reminders,
    removeReminder,
    setUseDefaultReminders,
  } = model;
  const presets: ReadonlyArray<number> = isAllDay
    ? ALL_DAY_REMINDER_PRESET_MINUTES
    : REMINDER_PRESET_MINUTES;
  const popups = reminders.overrides
    .map((override, index) => ({ index, override }))
    .filter(({ override }) => override.method === 'popup');
  const emails = reminders.overrides.filter((override) => override.method === 'email');
  const offsets = [
    ...new Set([...presets, ...popups.map(({ override }) => override.minutes)]),
  ].sort((a, b) => a - b);
  const useDefault = canUseDefaultReminders && reminders.useDefault;
  const full = reminders.overrides.length >= MAX_REMINDER_OVERRIDES;
  // What the calendar's default stands for, under the switch.
  const defaultSummary =
    calendarDefaultReminders.length === 0
      ? 'None'
      : calendarDefaultReminders
          .map((minutes) => reminderLabel(minutes, isAllDay))
          .join(', ')
          .replace(/^./, (first) => first.toUpperCase());

  const toggle = (minutes: number) => {
    const selected = popups.find(({ override }) => override.minutes === minutes);
    if (selected) {
      removeReminder(selected.index);
    } else {
      addReminder(minutes);
    }
  };

  return (
    <Section header="Notifications" testID="event-reminders" tight>
      {canUseDefaultReminders ? (
        <SwitchRow
          disabled={readOnly}
          onValueChange={setUseDefaultReminders}
          subtitle={defaultSummary}
          switchTestID="event-reminders-default"
          title="Calendar default"
          value={reminders.useDefault}
        />
      ) : null}
      {useDefault ? null : (
        // A turn that set the notifications tints the chips, inside the card.
        <FieldFlash bleedX={0} bleedY={0} field="reminders" radius={0}>
          <ChipsRow>
            {offsets.map((minutes) => {
              const selected = popups.some(({ override }) => override.minutes === minutes);
              return (
                <Chip
                  disabled={readOnly || (full && !selected)}
                  key={minutes}
                  label={reminderLabel(minutes, isAllDay)}
                  onPress={() => toggle(minutes)}
                  selected={selected}
                  testID={`event-reminder-${String(minutes)}${selected ? '-on' : ''}`}
                />
              );
            })}
          </ChipsRow>
        </FieldFlash>
      )}
      {emails.map((override) => (
        <Row
          key={`email-${String(override.minutes)}`}
          title={`Email · ${reminderLabel(override.minutes, isAllDay)}`}
        />
      ))}
    </Section>
  );
}
