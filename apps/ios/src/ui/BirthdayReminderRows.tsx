import {
  addBirthdayReminder,
  BIRTHDAY_LEAD_DAYS,
  type BirthdayReminder,
  leadDaysLabel,
  removeBirthdayReminder,
  setBirthdayReminderTime,
} from '@calendar/core';
import DateTimePicker from '@react-native-community/datetimepicker';
import { ActionSheetIOS } from 'react-native';
import { dateFromParts, toTimeString } from './editSheetShared.ts';
import { ActionRow, Rows, SwipeRow } from './GroupedList.tsx';

/**
 * Birthday reminders as grouped-list rows: one per reminder, its own
 * time picker beside it and Delete behind a swipe, then "Add Reminder",
 * which offers the lead times not taken yet (a new one starts at the
 * nearest one's time). Shared by Settings › Notifications (everyone) and
 * the birthday detail (one person); `testIDPrefix` tells them apart.
 */
export function BirthdayReminderRows({
  onChange,
  reminders,
  testIDPrefix,
}: {
  onChange: (reminders: ReadonlyArray<BirthdayReminder>) => void;
  reminders: ReadonlyArray<BirthdayReminder>;
  testIDPrefix: string;
}) {
  const free = BIRTHDAY_LEAD_DAYS.filter(
    (lead) => !reminders.some((reminder) => reminder.leadDays === lead),
  );
  const add = () =>
    ActionSheetIOS.showActionSheetWithOptions(
      {
        cancelButtonIndex: free.length,
        options: [...free.map((lead) => leadDaysLabel(lead)), 'Cancel'],
        title: 'Remind Me',
      },
      (index) => {
        const lead = free[index];
        if (lead !== undefined) {
          onChange(addBirthdayReminder(reminders, lead));
        }
      },
    );
  return (
    <Rows>
      {reminders.map(({ leadDays, time }) => {
        const label = leadDaysLabel(leadDays);
        return (
          <SwipeRow
            accessory={
              <DateTimePicker
                accessibilityLabel={`${label}, time`}
                display="compact"
                mode="time"
                onChange={(_, picked) => {
                  if (picked) {
                    onChange(setBirthdayReminderTime(reminders, leadDays, toTimeString(picked)));
                  }
                }}
                testID={`${testIDPrefix}-${String(leadDays)}-time`}
                value={dateFromParts('2026-01-01', time)}
              />
            }
            action={() => onChange(removeBirthdayReminder(reminders, leadDays))}
            actionLabel="Delete"
            actionTestID={`${testIDPrefix}-${String(leadDays)}-delete`}
            key={leadDays}
            testID={`${testIDPrefix}-${String(leadDays)}`}
            title={label}
          />
        );
      })}
      {free.length > 0 ? (
        <ActionRow onPress={add} testID={`${testIDPrefix}-add`} title="Add Reminder" />
      ) : null}
    </Rows>
  );
}
