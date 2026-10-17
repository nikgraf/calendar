import {
  MONTHLY_MODE_OPTIONS,
  ORDINAL_OPTIONS,
  REPEAT_ENDS_OPTIONS,
  REPEAT_OPTIONS,
  type useRepeatState,
  WEEKDAY_OPTIONS,
} from '@calendar/app-state';
import DateTimePicker from '@react-native-community/datetimepicker';
import { TextInput } from 'react-native';
import { Chip } from './Chip.tsx';
import { dateFromParts, toDateString, useSheetStyles } from './editSheetShared.ts';
import { ChipsRow, Footer, Row, Section } from './GroupedList.tsx';
import { useTheme } from './theme.ts';

/** The repeat form state both editors expose (everything but the spec exit). */
export type RepeatRuleState = Omit<ReturnType<typeof useRepeatState>, 'toSpec'>;

/**
 * The repeat rule as one card, shared by the event and the reminder
 * form: frequency, then the rows a frequency brings — the weekday
 * toggles of a weekly rule, the "day of the month" / "Nth weekday" choice
 * of a monthly rule, the interval, the end condition — and a summary in
 * Reminders.app's words as the card's footer. Chips report their
 * selection through accessibilityState, which Maestro can assert;
 * testIDs start with `testIDPrefix` (`reminder-repeat-weekly`,
 * `-weekday-MO`, `-monthly-weekday`, `-ordinal-2`, `-ordinal-weekday-TU`,
 * `-summary`).
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
  const styles = useSheetStyles();
  const { colors } = useTheme();
  const repeats = state.repeat !== 'none';
  const nthWeekday = state.repeat === 'monthly' && state.repeatMonthly === 'weekday';
  return (
    <Section
      footer={
        state.repeatSummary ? (
          <Footer testID={`${testIDPrefix}-summary`}>{state.repeatSummary}</Footer>
        ) : undefined
      }
      header="Repeat"
      tight
    >
      <ChipsRow>
        {REPEAT_OPTIONS.map((entry) => (
          <Chip
            key={entry.value}
            label={entry.short}
            onPress={() => state.setRepeat(entry.value)}
            selected={state.repeat === entry.value}
            testID={`${testIDPrefix}-${entry.value}`}
          />
        ))}
      </ChipsRow>
      {state.repeat === 'weekly' ? (
        <ChipsRow label="On">
          {WEEKDAY_OPTIONS.map((entry) => (
            <Chip
              key={entry.value}
              label={entry.short}
              onPress={() => state.toggleWeekday(entry.value)}
              selected={state.repeatWeekdays.includes(entry.value)}
              testID={`${testIDPrefix}-weekday-${entry.value}`}
            />
          ))}
        </ChipsRow>
      ) : null}
      {state.repeat === 'monthly' ? (
        <ChipsRow label="Monthly on">
          {MONTHLY_MODE_OPTIONS.map((entry) => (
            <Chip
              key={entry.value}
              label={
                entry.value === 'dayOfMonth'
                  ? `Day ${anchorDate.slice(8).replace(/^0/, '')}`
                  : entry.short
              }
              onPress={() => state.setRepeatMonthly(entry.value)}
              selected={state.repeatMonthly === entry.value}
              testID={`${testIDPrefix}-monthly-${entry.value}`}
            />
          ))}
        </ChipsRow>
      ) : null}
      {nthWeekday ? (
        <ChipsRow label="Which">
          {ORDINAL_OPTIONS.map((entry) => (
            <Chip
              key={entry.value}
              label={entry.short}
              onPress={() => state.setRepeatOrdinal(entry.value)}
              selected={state.repeatOrdinal === entry.value}
              testID={`${testIDPrefix}-ordinal-${String(entry.value)}`}
            />
          ))}
        </ChipsRow>
      ) : null}
      {nthWeekday ? (
        <ChipsRow label="Weekday">
          {WEEKDAY_OPTIONS.map((entry) => (
            <Chip
              key={entry.value}
              label={entry.short}
              onPress={() => state.setRepeatOrdinalWeekday(entry.value)}
              selected={state.repeatOrdinalWeekday === entry.value}
              testID={`${testIDPrefix}-ordinal-weekday-${entry.value}`}
            />
          ))}
        </ChipsRow>
      ) : null}
      {repeats ? (
        <Row
          accessory={
            <TextInput
              keyboardType="number-pad"
              onChangeText={state.setRepeatInterval}
              placeholderTextColor={colors['text-secondary']}
              style={styles.accessoryField}
              testID={`${testIDPrefix}-interval`}
              value={state.repeatInterval}
            />
          }
          title="Every (n)"
        />
      ) : null}
      {repeats ? (
        <ChipsRow label="Ends">
          {REPEAT_ENDS_OPTIONS.map((entry) => (
            <Chip
              key={entry.value}
              label={entry.short}
              onPress={() => {
                state.setRepeatEnds(entry.value);
                // The picker renders a date even while the model holds
                // '' — seed it, or a save would drop the end bound.
                if (entry.value === 'on' && !state.repeatUntil) {
                  state.setRepeatUntil(anchorDate);
                }
              }}
              selected={state.repeatEnds === entry.value}
              testID={`${testIDPrefix}-ends-${entry.value}`}
            />
          ))}
        </ChipsRow>
      ) : null}
      {repeats && state.repeatEnds === 'after' ? (
        <Row
          accessory={
            <TextInput
              keyboardType="number-pad"
              onChangeText={state.setRepeatCount}
              placeholder="10"
              placeholderTextColor={colors['text-secondary']}
              style={styles.accessoryField}
              testID={`${testIDPrefix}-count`}
              value={state.repeatCount}
            />
          }
          title="Occurrences"
        />
      ) : null}
      {repeats && state.repeatEnds === 'on' ? (
        <Row
          accessory={
            <DateTimePicker
              display="compact"
              minimumDate={dateFromParts(anchorDate)}
              mode="date"
              onChange={(_, picked) => picked && state.setRepeatUntil(toDateString(picked))}
              value={dateFromParts(state.repeatUntil || anchorDate)}
            />
          }
          title="Until"
        />
      ) : null}
    </Section>
  );
}
