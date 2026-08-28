import type { useEventEditorModel } from '@calendar/app-state';
import DateTimePicker from '@react-native-community/datetimepicker';
import { Linking, Pressable, ScrollView, Switch, Text, TextInput, View } from 'react-native';
import {
  dateFromParts,
  REPEAT_ENDS,
  REPEATS,
  RSVPS,
  SCOPES,
  sheetStyles as styles,
  toDateString,
  toTimeString,
} from './editSheetShared.ts';

/** The event half of EventEditSheet (mode === 'event'). */
export function EventEditForm({ model }: { model: ReturnType<typeof useEventEditorModel> }) {
  const {
    calendarKey,
    date,
    endTime,
    error,
    existing,
    isAllDay,
    isRecurring,
    joinUrl,
    location,
    ownAttendee,
    remove,
    repeat,
    repeatCount,
    repeatEnds,
    repeatInterval,
    repeatUntil,
    respond,
    rsvp,
    scope,
    setCalendarKey,
    setDate,
    setEndTime,
    setIsAllDay,
    setLocation,
    setRepeat,
    setRepeatCount,
    setRepeatEnds,
    setRepeatInterval,
    setRepeatUntil,
    setScope,
    setStartTime,
    setTitle,
    startTime,
    title,
    writableCalendars: writable,
  } = model;

  return (
    <ScrollView contentContainerStyle={styles.content}>
      {error ? <Text style={styles.error}>{error}</Text> : null}
      {joinUrl ? (
        <Pressable onPress={() => void Linking.openURL(joinUrl)} style={styles.joinButton}>
          <Text style={styles.joinLabel}>Join meeting</Text>
        </Pressable>
      ) : null}
      {isRecurring ? (
        <View style={styles.scopeRow}>
          {SCOPES.map((option) => (
            <Pressable
              key={option.value}
              onPress={() => setScope(option.value)}
              style={[styles.scopeChip, scope === option.value && styles.scopeChipActive]}
            >
              <Text style={[styles.scopeLabel, scope === option.value && styles.scopeLabelActive]}>
                {option.label}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      <>
        <TextInput
          autoFocus={!existing}
          onChangeText={setTitle}
          placeholder="Title"
          style={styles.input}
          testID="event-title"
          value={title}
        />

        <Text style={styles.label}>Calendar</Text>
        {writable.map((calendar) => {
          const key = `${calendar.accountId}:${calendar.id}`;
          const selected = key === calendarKey;
          return (
            <Pressable
              disabled={Boolean(existing)}
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

        <View style={styles.switchRow}>
          <Text style={styles.label}>All-day</Text>
          <Switch onValueChange={setIsAllDay} value={isAllDay} />
        </View>

        {existing ? null : (
          <>
            <Text style={styles.label}>Repeat</Text>
            <View style={styles.scopeRow}>
              {REPEATS.map((option) => (
                <Pressable
                  key={option.value}
                  onPress={() => setRepeat(option.value)}
                  style={[styles.scopeChip, repeat === option.value && styles.scopeChipActive]}
                >
                  <Text
                    style={[styles.scopeLabel, repeat === option.value && styles.scopeLabelActive]}
                  >
                    {option.label}
                  </Text>
                </Pressable>
              ))}
            </View>
            {repeat === 'none' ? null : (
              <View style={styles.timesRow}>
                <View style={styles.timeField}>
                  <Text style={styles.label}>Every (n)</Text>
                  <TextInput
                    keyboardType="number-pad"
                    onChangeText={setRepeatInterval}
                    style={styles.input}
                    value={repeatInterval}
                  />
                </View>
                <View style={styles.timeField}>
                  <Text style={styles.label}>Ends</Text>
                  <View style={styles.scopeRow}>
                    {REPEAT_ENDS.map((option) => (
                      <Pressable
                        key={option.value}
                        onPress={() => {
                          setRepeatEnds(option.value);
                          // The picker chip renders a date even while the
                          // model still holds '' — seed it, or a save
                          // would silently drop the end bound and create
                          // an unbounded recurrence.
                          if (option.value === 'on' && !repeatUntil) {
                            setRepeatUntil(date);
                          }
                        }}
                        style={[
                          styles.scopeChip,
                          repeatEnds === option.value && styles.scopeChipActive,
                        ]}
                      >
                        <Text
                          style={[
                            styles.scopeLabel,
                            repeatEnds === option.value && styles.scopeLabelActive,
                          ]}
                        >
                          {option.label}
                        </Text>
                      </Pressable>
                    ))}
                  </View>
                </View>
              </View>
            )}

            {repeat !== 'none' && repeatEnds === 'after' ? (
              <>
                <Text style={styles.label}>Occurrences</Text>
                <TextInput
                  keyboardType="number-pad"
                  onChangeText={setRepeatCount}
                  placeholder="10"
                  style={styles.input}
                  value={repeatCount}
                />
              </>
            ) : null}

            {repeat !== 'none' && repeatEnds === 'on' ? (
              <>
                <View style={styles.pickerRow}>
                  <Text style={styles.label}>Ends on</Text>
                  <DateTimePicker
                    display="compact"
                    mode="date"
                    onChange={(_, picked) => picked && setRepeatUntil(toDateString(picked))}
                    value={dateFromParts(repeatUntil || date)}
                  />
                </View>
              </>
            ) : null}
          </>
        )}

        <View style={styles.pickerRow} testID="event-date">
          <Text style={styles.label}>Date</Text>
          <DateTimePicker
            display="compact"
            mode="date"
            onChange={(_, picked) => picked && setDate(toDateString(picked))}
            value={dateFromParts(date)}
          />
        </View>
        {isAllDay ? null : (
          <View style={styles.timesRow}>
            <View style={styles.timeField} testID="event-start">
              <Text style={styles.label}>Start</Text>
              <DateTimePicker
                display="compact"
                mode="time"
                onChange={(_, picked) => picked && setStartTime(toTimeString(picked))}
                style={styles.timePicker}
                value={dateFromParts(date, startTime)}
              />
            </View>
            <View style={styles.timeField} testID="event-end">
              <Text style={styles.label}>End</Text>
              <DateTimePicker
                display="compact"
                mode="time"
                onChange={(_, picked) => picked && setEndTime(toTimeString(picked))}
                style={styles.timePicker}
                value={dateFromParts(date, endTime)}
              />
            </View>
          </View>
        )}

        <Text style={styles.label}>Location</Text>
        <TextInput
          onChangeText={setLocation}
          placeholder="Add a location"
          style={styles.input}
          value={location}
        />

        {existing?.attendees?.length ? (
          <>
            <Text style={styles.label}>Invitees</Text>
            {ownAttendee ? (
              <View style={styles.scopeRow}>
                {RSVPS.map((option) => (
                  <Pressable
                    key={option.value}
                    onPress={() => void respond(option.value)}
                    style={[styles.scopeChip, rsvp === option.value && styles.scopeChipActive]}
                  >
                    <Text
                      style={[styles.scopeLabel, rsvp === option.value && styles.scopeLabelActive]}
                    >
                      {option.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            ) : null}
            {existing.attendees.map((attendee) => (
              <Text key={attendee.email} style={styles.attendee}>
                {attendee.displayName ?? attendee.email} · {attendee.responseStatus}
              </Text>
            ))}
          </>
        ) : null}

        {existing ? (
          <Pressable
            onPress={() => void remove()}
            style={styles.deleteButton}
            testID="event-delete"
          >
            <Text style={styles.deleteLabel}>Delete Event</Text>
          </Pressable>
        ) : null}
      </>
    </ScrollView>
  );
}
