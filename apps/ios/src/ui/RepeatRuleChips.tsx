import {
  MONTHLY_MODE_OPTIONS,
  ORDINAL_OPTIONS,
  REPEAT_ENDS_OPTIONS,
  REPEAT_OPTIONS,
  type useRepeatState,
  WEEKDAY_OPTIONS,
} from '@calendar/app-state';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Pressable, Text, TextInput, View } from 'react-native';
import {
  chip,
  chipLabel,
  dateFromParts,
  sheetStyles as styles,
  toDateString,
} from './editSheetShared.ts';

/** The repeat form state both editors expose (everything but the spec exit). */
export type RepeatRuleState = Omit<ReturnType<typeof useRepeatState>, 'toSpec'>;

/** One selectable chip; `accessibilityState.selected` is what Maestro asserts. */
const option = (selected: boolean, label: string, onPress: () => void, testID: string) => (
  <Pressable
    accessibilityRole="button"
    accessibilityState={{ selected }}
    key={testID}
    onPress={onPress}
    style={chip(selected)}
    testID={testID}
  >
    <Text style={chipLabel(selected)}>{label}</Text>
  </Pressable>
);

/**
 * The repeat rule chips shared by the event and the reminder sheet:
 * frequency and interval, the weekday toggles of a weekly rule, the "day
 * of the month" / "Nth weekday" choice of a monthly rule, the end
 * condition, and a summary in Reminders.app's words. Chips report their
 * selection through accessibilityState, which Maestro can assert; testIDs
 * start with `testIDPrefix` (`reminder-repeat-weekly`, `-weekday-MO`,
 * `-monthly-weekday`, `-ordinal-2`, `-ordinal-weekday-TU`, `-summary`).
 */
export function RepeatRuleChips({
  anchorDate,
  state,
  testIDPrefix,
}: {
  /** The due/start date: seeds "until" and names the monthly day. */
  anchorDate: string;
  state: RepeatRuleState;
  testIDPrefix: string;
}) {
  return (
    <>
      <Text style={styles.label}>Repeat</Text>
      <View style={styles.scopeRow}>
        {REPEAT_OPTIONS.map((entry) =>
          option(
            state.repeat === entry.value,
            entry.short,
            () => state.setRepeat(entry.value),
            `${testIDPrefix}-${entry.value}`,
          ),
        )}
      </View>
      {state.repeat === 'weekly' ? (
        <>
          <Text style={styles.label}>On</Text>
          <View style={styles.scopeRow}>
            {WEEKDAY_OPTIONS.map((entry) =>
              option(
                state.repeatWeekdays.includes(entry.value),
                entry.short,
                () => state.toggleWeekday(entry.value),
                `${testIDPrefix}-weekday-${entry.value}`,
              ),
            )}
          </View>
        </>
      ) : null}
      {state.repeat === 'monthly' ? (
        <>
          <Text style={styles.label}>Monthly on</Text>
          <View style={styles.scopeRow}>
            {MONTHLY_MODE_OPTIONS.map((entry) =>
              option(
                state.repeatMonthly === entry.value,
                entry.value === 'dayOfMonth'
                  ? `Day ${anchorDate.slice(8).replace(/^0/, '')}`
                  : entry.short,
                () => state.setRepeatMonthly(entry.value),
                `${testIDPrefix}-monthly-${entry.value}`,
              ),
            )}
          </View>
          {state.repeatMonthly === 'weekday' ? (
            <>
              <View style={styles.scopeRow}>
                {ORDINAL_OPTIONS.map((entry) =>
                  option(
                    state.repeatOrdinal === entry.value,
                    entry.short,
                    () => state.setRepeatOrdinal(entry.value),
                    `${testIDPrefix}-ordinal-${String(entry.value)}`,
                  ),
                )}
              </View>
              <View style={styles.scopeRow}>
                {WEEKDAY_OPTIONS.map((entry) =>
                  option(
                    state.repeatOrdinalWeekday === entry.value,
                    entry.short,
                    () => state.setRepeatOrdinalWeekday(entry.value),
                    `${testIDPrefix}-ordinal-weekday-${entry.value}`,
                  ),
                )}
              </View>
            </>
          ) : null}
        </>
      ) : null}
      {state.repeat === 'none' ? null : (
        <View style={styles.timesRow}>
          <View style={styles.timeField}>
            <Text style={styles.label}>Every (n)</Text>
            <TextInput
              keyboardType="number-pad"
              onChangeText={state.setRepeatInterval}
              style={styles.input}
              testID={`${testIDPrefix}-interval`}
              value={state.repeatInterval}
            />
          </View>
          <View style={styles.timeField}>
            <Text style={styles.label}>Ends</Text>
            <View style={styles.scopeRow}>
              {REPEAT_ENDS_OPTIONS.map((entry) =>
                option(
                  state.repeatEnds === entry.value,
                  entry.short,
                  () => {
                    state.setRepeatEnds(entry.value);
                    // The picker renders a date even while the model holds
                    // '' — seed it, or a save would drop the end bound.
                    if (entry.value === 'on' && !state.repeatUntil) {
                      state.setRepeatUntil(anchorDate);
                    }
                  },
                  `${testIDPrefix}-ends-${entry.value}`,
                ),
              )}
            </View>
          </View>
        </View>
      )}
      {state.repeat !== 'none' && state.repeatEnds === 'after' ? (
        <View style={styles.timeField}>
          <Text style={styles.label}>Occurrences</Text>
          <TextInput
            keyboardType="number-pad"
            onChangeText={state.setRepeatCount}
            placeholder="10"
            style={styles.input}
            testID={`${testIDPrefix}-count`}
            value={state.repeatCount}
          />
        </View>
      ) : null}
      {state.repeat !== 'none' && state.repeatEnds === 'on' ? (
        <View style={styles.pickerRow}>
          <Text style={styles.label}>Until</Text>
          <DateTimePicker
            display="compact"
            mode="date"
            onChange={(_, picked) => picked && state.setRepeatUntil(toDateString(picked))}
            value={dateFromParts(state.repeatUntil || anchorDate)}
          />
        </View>
      ) : null}
      {state.repeatSummary ? (
        <Text style={styles.hint} testID={`${testIDPrefix}-summary`}>
          {state.repeatSummary}
        </Text>
      ) : null}
    </>
  );
}
