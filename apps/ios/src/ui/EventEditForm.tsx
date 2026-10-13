import {
  calendarGroups,
  RSVP_OPTIONS,
  SCOPE_OPTIONS,
  useAccounts,
  type useEventEditorModel,
  useTimeZones,
} from '@calendar/app-state';
import { type CalendarInfo, draftZoneRanges } from '@calendar/core';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Linking, Pressable, Switch, Text, TextInput, View } from 'react-native';
import { FormScroll } from './FormScroll.tsx';
import { useSheetStyles } from './editSheetShared.ts';
import { dateForPicker, dateStringFromPicker, timeStringFromPicker } from './pickerDates.ts';
import { FindTimeFields } from './FindTimeFields.tsx';
import { FieldFlash } from './FlashView.tsx';
import { InviteeField } from './InviteeField.tsx';
import { LocationField } from './LocationField.tsx';
import { LocationMap } from './LocationMap.tsx';
import { ReminderChips } from './ReminderChips.tsx';
import { RepeatRuleChips } from './RepeatRuleChips.tsx';
import { ZoneLines } from './ZoneLines.tsx';

/** Which account (or, for Apple, which EventKit source) a calendar belongs to. */
const groupLabel = (calendar: CalendarInfo, emailOf: (accountId: string) => string): string =>
  calendar.provider === 'apple'
    ? `Apple Calendar · ${calendar.sourceTitle ?? 'This iPhone'}`
    : emailOf(calendar.accountId);

/** The event half of EventEditSheet (mode === 'event'). */
export function EventEditForm({
  autoFocusTitle = true,
  bare,
  model,
}: {
  /** Off when the quick-add field above the form takes the focus. */
  autoFocusTitle?: boolean;
  /** The content only: the sheet around it owns the scroll view (`FormScroll`). */
  bare?: boolean | undefined;
  model: ReturnType<typeof useEventEditorModel>;
}) {
  const styles = useSheetStyles();
  const accounts = useAccounts();
  const { secondary: secondaryZones } = useTimeZones();
  const emailOf = (accountId: string) =>
    accounts.find((account) => account.id === accountId)?.email ?? accountId;
  const {
    addAttendee,
    attendees,
    attendeeStatus,
    busy,
    calendarKey,
    canInvite,
    canMoveCalendar,
    canRsvp,
    canSwitchAllDay,
    date,
    description,
    endTime,
    error,
    existing,
    isAllDay,
    isRecurring,
    joinUrl,
    readOnly,
    remove,
    removeAttendee,
    respond,
    rsvp,
    scope,
    setCalendarKey,
    setDate,
    setDescription,
    setEndTime,
    setIsAllDay,
    setScope,
    setStartTime,
    setTitle,
    startTime,
    title,
    writableCalendars: writable,
  } = model;
  const { timeZone } = model;
  // The draft's times in the other zones; null for all-day or before the times build.
  const zoneLines = draftZoneRanges(
    { date, endTime, isAllDay, startTime },
    timeZone,
    secondaryZones,
  );

  return (
    // Keyboard insets: the invitee field and its suggestions sit at the
    // bottom of the form, under the keyboard the auto-focused title
    // raises; without the inset they cannot be scrolled into reach.
    <FormScroll bare={bare} contentStyle={styles.content}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {readOnly ? (
        <Text style={styles.label} testID="event-read-only">
          This calendar is read-only.
        </Text>
      ) : null}
      {joinUrl ? (
        <Pressable onPress={() => void Linking.openURL(joinUrl)} style={styles.joinButton}>
          <Text style={styles.joinLabel}>Join meeting</Text>
        </Pressable>
      ) : null}
      {isRecurring ? (
        <View style={styles.scopeRow}>
          {SCOPE_OPTIONS.map((option) => (
            <Pressable
              key={option.value}
              onPress={() => setScope(option.value)}
              style={[styles.scopeChip, scope === option.value && styles.scopeChipActive]}
            >
              <Text style={[styles.scopeLabel, scope === option.value && styles.scopeLabelActive]}>
                {option.short}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <>
        <FieldFlash bleedX={0} bleedY={0} field="title" style={styles.inputBox}>
          <TextInput
            autoFocus={autoFocusTitle && !existing}
            // The system ⓧ ("Clear text"): renaming starts from an empty field
            // instead of deleting the old title character by character.
            clearButtonMode="while-editing"
            editable={!readOnly}
            onChangeText={setTitle}
            placeholder="Title"
            style={[styles.input, styles.inputInBox]}
            testID="event-title"
            value={title}
          />
        </FieldFlash>

        {readOnly ? null : <Text style={styles.label}>Calendar</Text>}
        {readOnly
          ? null
          : calendarGroups(writable, (calendar) => groupLabel(calendar, emailOf)).map((group) => (
              <View key={group.label}>
                <Text style={styles.calendarGroup}>{group.label}</Text>
                {group.calendars.map((calendar) => {
                  const key = `${calendar.accountId}:${calendar.id}`;
                  const selected = key === calendarKey;
                  return (
                    <Pressable
                      // Moving takes the whole series: pick "All" to move one.
                      disabled={Boolean(existing) && !canMoveCalendar}
                      key={key}
                      onPress={() => setCalendarKey(key)}
                      style={styles.calendarRow}
                      testID="calendar-option"
                    >
                      <View style={[styles.swatch, { backgroundColor: calendar.colorHex }]} />
                      <Text style={[styles.calendarName, selected && styles.calendarSelected]}>
                        {calendar.summary}
                      </Text>
                      {selected ? <Text style={styles.check}>✓</Text> : null}
                    </Pressable>
                  );
                })}
              </View>
            ))}

        <FieldFlash field={isAllDay ? 'time' : null} style={styles.switchRow}>
          <Text style={styles.label}>All-day</Text>
          <Switch
            // A repeating event keeps its kind (timed or all-day).
            disabled={!canSwitchAllDay}
            onValueChange={setIsAllDay}
            testID="event-all-day"
            value={isAllDay}
          />
        </FieldFlash>

        {model.repeatLoaded ? (
          <FieldFlash field="repeat">
            <RepeatRuleChips anchorDate={date} state={model} testIDPrefix="event-repeat" />
          </FieldFlash>
        ) : null}

        {/* The date and time rows touch: their tints meet rather than overlap. */}
        <FieldFlash bleedY={0} field="date" style={styles.pickerRow} testID="event-date">
          <Text style={styles.label}>Date</Text>
          <DateTimePicker
            display="compact"
            mode="date"
            onChange={(_, picked) => picked && setDate(dateStringFromPicker(picked, timeZone))}
            timeZoneName={timeZone}
            value={dateForPicker(date, undefined, timeZone)}
          />
        </FieldFlash>
        {isAllDay ? null : (
          <FieldFlash bleedY={0} field="time" style={styles.timesRow}>
            <View style={styles.timeField} testID="event-start">
              <Text style={styles.label}>Start</Text>
              <DateTimePicker
                display="compact"
                mode="time"
                onChange={(_, picked) =>
                  picked && setStartTime(timeStringFromPicker(picked, timeZone))
                }
                style={styles.timePicker}
                timeZoneName={timeZone}
                value={dateForPicker(date, startTime, timeZone)}
              />
            </View>
            <View style={styles.timeField} testID="event-end">
              <Text style={styles.label}>End</Text>
              <DateTimePicker
                display="compact"
                mode="time"
                onChange={(_, picked) =>
                  picked && setEndTime(timeStringFromPicker(picked, timeZone))
                }
                style={styles.timePicker}
                timeZoneName={timeZone}
                value={dateForPicker(date, endTime, timeZone)}
              />
            </View>
          </FieldFlash>
        )}
        {zoneLines ? <ZoneLines lines={zoneLines} textStyle={styles.hint} /> : null}
        {readOnly ? null : <FindTimeFields model={model} />}

        <Text style={styles.label}>Location</Text>
        <LocationField model={model} />
        <LocationMap model={model} />

        {canInvite ? (
          <>
            <Text style={styles.label}>Invitees</Text>
            {canRsvp ? (
              <View style={styles.scopeRow}>
                {RSVP_OPTIONS.map((option) => (
                  <Pressable
                    key={option.value}
                    onPress={() => void respond(option.value)}
                    style={[styles.scopeChip, rsvp === option.value && styles.scopeChipActive]}
                  >
                    <Text
                      style={[styles.scopeLabel, rsvp === option.value && styles.scopeLabelActive]}
                    >
                      {option.short}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            <InviteeField
              attendees={attendees}
              attendeeStatus={attendeeStatus}
              onAdd={addAttendee}
              onRemove={removeAttendee}
            />
          </>
        ) : (existing?.attendees ?? []).length > 0 ? (
          // EventKit cannot write guests: shown as they are, never edited.
          <View testID="event-guests-read-only">
            <Text style={styles.label}>Guests</Text>
            {existing?.attendees?.map((attendee) => (
              <Text key={attendee.email} style={styles.calendarName}>
                {attendee.displayName ?? attendee.email}
              </Text>
            ))}
          </View>
        ) : null}

        <ReminderChips model={model} />

        {/* A read-only calendar shows its notes but offers no empty field. */}
        {readOnly && !description ? null : (
          <>
            <Text style={styles.label}>Notes</Text>
            <TextInput
              editable={!readOnly}
              multiline
              numberOfLines={3}
              onChangeText={setDescription}
              placeholder="Add notes"
              style={[styles.input, styles.notesInput]}
              testID="event-notes"
              value={description}
            />
          </>
        )}

        {existing && !readOnly ? (
          <Pressable
            onPress={() => void remove()}
            style={[styles.deleteButton, busy && styles.busy]}
            testID="event-delete"
          >
            <Text style={styles.deleteLabel}>Delete Event</Text>
          </Pressable>
        ) : null}
      </>
    </FormScroll>
  );
}
