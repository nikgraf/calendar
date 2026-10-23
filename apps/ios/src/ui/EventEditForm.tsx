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
import { Linking, Pressable, Text, View } from 'react-native';
import { Chip } from './Chip.tsx';
import { useSheetStyles } from './editSheetShared.ts';
import { FindTimeFields } from './FindTimeFields.tsx';
import { FieldFlash } from './FlashView.tsx';
import { FormScroll } from './FormScroll.tsx';
import {
  ActionRow,
  CardCaption,
  CheckRow,
  ChipsRow,
  ColorDot,
  FieldRow,
  Row,
  RowSlot,
  Section,
  SwitchRow,
} from './GroupedList.tsx';
import { InviteeField } from './InviteeField.tsx';
import { LocationField } from './LocationField.tsx';
import { LocationMap } from './LocationMap.tsx';
import { dateForPicker, dateStringFromPicker, timeStringFromPicker } from './pickerDates.ts';
import { ReminderChips } from './ReminderChips.tsx';
import { RepeatRuleChips } from './RepeatRuleChips.tsx';
import { SegmentedControl } from './SegmentedControl.tsx';
import { ZoneLines } from './ZoneLines.tsx';

/** Which account (or, for Apple, which EventKit source) a calendar belongs to. */
const groupLabel = (calendar: CalendarInfo, emailOf: (accountId: string) => string): string =>
  calendar.provider === 'apple'
    ? `Apple Calendar · ${calendar.sourceTitle ?? 'This iPhone'}`
    : emailOf(calendar.accountId);

/**
 * The event half of EventEditSheet (mode === 'event'), as grouped cards
 * in Calendar's own order: title and location; all-day, the dates and
 * the finder; the repeat rule; the calendar; invitees; notifications;
 * notes; Delete. The flows find the rows by test id and the cards by
 * their uppercase headers ("CALENDAR", "REPEAT").
 */
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
    endDate,
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
    setEndDate,
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
    { date, endDate, endTime, isAllDay, startTime },
    timeZone,
    secondaryZones,
  );
  const groups = calendarGroups(writable, (calendar) => groupLabel(calendar, emailOf));
  const guests = existing?.attendees ?? [];

  /* Start and end each get a row, a day and a time: a multi-day or
     overnight event ends on a later day (Calendar's Starts/Ends). */
  const datePickers = (
    which: 'end' | 'start',
    day: string,
    time: string,
    setDay: (next: string) => void,
    setTime: (next: string) => void,
  ) => (
    <View style={styles.pickerPair}>
      <FieldFlash
        bleedY={2}
        field="date"
        testID={which === 'start' ? 'event-date' : 'event-end-date'}
      >
        <DateTimePicker
          display="compact"
          mode="date"
          onValueChange={(_, picked) => setDay(dateStringFromPicker(picked, timeZone))}
          timeZoneName={timeZone}
          value={dateForPicker(day, undefined, timeZone)}
        />
      </FieldFlash>
      {isAllDay ? null : (
        <FieldFlash bleedY={2} field="time">
          <DateTimePicker
            display="compact"
            mode="time"
            onValueChange={(_, picked) => setTime(timeStringFromPicker(picked, timeZone))}
            timeZoneName={timeZone}
            value={dateForPicker(day, time, timeZone)}
          />
        </FieldFlash>
      )}
    </View>
  );

  return (
    // Keyboard insets: the invitee field and its suggestions sit at the
    // bottom of the form, under the keyboard the auto-focused title
    // raises; without the inset they cannot be scrolled into reach.
    <FormScroll bare={bare} contentStyle={styles.content}>
      {error ? (
        <Text selectable style={styles.formError}>
          {error}
        </Text>
      ) : null}
      {readOnly ? (
        <Text style={styles.formNote} testID="event-read-only">
          This calendar is read-only.
        </Text>
      ) : null}
      {joinUrl ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => void Linking.openURL(joinUrl)}
          style={styles.joinButton}
        >
          <Text style={styles.joinLabel}>Join meeting</Text>
        </Pressable>
      ) : null}
      {isRecurring ? (
        <View style={styles.topControl}>
          <SegmentedControl
            accessibilityLabel="Apply to"
            ground
            grow
            onChange={setScope}
            options={SCOPE_OPTIONS.map((option) => ({ label: option.short, value: option.value }))}
            value={scope}
          />
        </View>
      ) : null}

      <Section tight>
        <FieldFlash bleedX={0} bleedY={0} field="title" radius={0}>
          <FieldRow
            autoFocus={autoFocusTitle && !existing}
            // The system ⓧ ("Clear text"): renaming starts from an empty field
            // instead of deleting the old title character by character.
            clearButtonMode="while-editing"
            editable={!readOnly}
            onChangeText={setTitle}
            placeholder="Title"
            testID="event-title"
            value={title}
          />
        </FieldFlash>
        <LocationField model={model} />
      </Section>
      <LocationMap model={model} />

      <Section tight>
        <FieldFlash bleedX={0} bleedY={0} field={isAllDay ? 'time' : null} radius={0}>
          <SwitchRow
            // A repeating event keeps its kind (timed or all-day).
            disabled={!canSwitchAllDay}
            onValueChange={setIsAllDay}
            switchTestID="event-all-day"
            title="All-day"
            value={isAllDay}
          />
        </FieldFlash>
        <Row
          accessory={datePickers('start', date, startTime, setDate, setStartTime)}
          testID="event-start"
          title="Starts"
        />
        <Row
          accessory={datePickers('end', endDate, endTime, setEndDate, setEndTime)}
          testID="event-end"
          title="Ends"
        />
        {zoneLines ? (
          <RowSlot>
            <ZoneLines lines={zoneLines} textStyle={styles.hint} />
          </RowSlot>
        ) : null}
        {readOnly ? null : <FindTimeFields model={model} />}
      </Section>

      {readOnly ? null : (
        <Section header="Calendar" tight>
          {/* Each account named over its calendars, as Calendar's own picker does. */}
          {groups.flatMap((group) => [
            <CardCaption key={`caption:${group.label}`}>{group.label}</CardCaption>,
            ...group.calendars.map((calendar) => {
              const key = `${calendar.accountId}:${calendar.id}`;
              return (
                <CheckRow
                  checked={key === calendarKey}
                  // Moving takes the whole series: pick "All" to move one.
                  disabled={Boolean(existing) && !canMoveCalendar}
                  key={key}
                  leading={<ColorDot color={calendar.colorHex} />}
                  onPress={() => setCalendarKey(key)}
                  testID="calendar-option"
                  title={calendar.summary}
                />
              );
            }),
          ])}
        </Section>
      )}

      {model.repeatLoaded ? (
        <RepeatRuleChips anchorDate={date} state={model} testIDPrefix="event-repeat" />
      ) : null}

      {canInvite ? (
        <Section header="Invitees" tight>
          {canRsvp ? (
            <ChipsRow label="RSVP">
              {RSVP_OPTIONS.map((option) => (
                <Chip
                  key={option.value}
                  label={option.short}
                  onPress={() => void respond(option.value)}
                  selected={rsvp === option.value}
                />
              ))}
            </ChipsRow>
          ) : null}
          {/* A turn that changed the guests tints their rows, inside the card. */}
          <FieldFlash bleedX={0} bleedY={0} field="guests" radius={0}>
            <InviteeField
              attendees={attendees}
              attendeeStatus={attendeeStatus}
              onAdd={addAttendee}
              onRemove={removeAttendee}
            />
          </FieldFlash>
        </Section>
      ) : !existing && attendees.length > 0 ? (
        // Guests the form holds (typed, or said in a phrase) for another
        // calendar: kept, but not sent from this one — EventKit cannot.
        <Section header="Invitees" testID="event-invitees-held" tight>
          <RowSlot>
            <Text style={styles.hint}>
              Not invited from this calendar:{' '}
              {attendees.map((attendee) => attendee.displayName ?? attendee.email).join(', ')}
            </Text>
          </RowSlot>
        </Section>
      ) : guests.length > 0 ? (
        // EventKit cannot write guests: shown as they are, never edited.
        <Section header="Guests" testID="event-guests-read-only" tight>
          {guests.map((attendee) => (
            <Row key={attendee.email} title={attendee.displayName ?? attendee.email} />
          ))}
        </Section>
      ) : null}

      <ReminderChips model={model} />

      {/* A read-only calendar shows its notes but offers no empty field. */}
      {readOnly && !description ? null : (
        <Section header="Notes" tight>
          <FieldRow
            editable={!readOnly}
            multiline
            onChangeText={setDescription}
            placeholder="Add notes"
            testID="event-notes"
            value={description}
          />
        </Section>
      )}

      {existing && !readOnly ? (
        <Section tight>
          <ActionRow
            disabled={busy}
            onPress={() => void remove()}
            testID="event-delete"
            title="Delete Event"
            tone="destructive"
          />
        </Section>
      ) : null}
    </FormScroll>
  );
}
