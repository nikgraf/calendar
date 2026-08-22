import { useEventEditorModel, type EventEditorSeed } from '@calendar/app-state';
import {
  type CalendarInfo,
  type RecurrenceFrequency,
  type RecurringScope,
  type RsvpResponse,
} from '@calendar/core';
import {
  Linking,
  Modal,
  Pressable,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { palette } from './theme.ts';

const RSVPS: ReadonlyArray<{ label: string; value: RsvpResponse }> = [
  { label: 'Accept', value: 'accepted' },
  { label: 'Maybe', value: 'tentative' },
  { label: 'Decline', value: 'declined' },
];

const REPEATS: ReadonlyArray<{ label: string; value: RecurrenceFrequency | 'none' }> = [
  { label: 'None', value: 'none' },
  { label: 'Daily', value: 'daily' },
  { label: 'Weekly', value: 'weekly' },
  { label: 'Monthly', value: 'monthly' },
  { label: 'Yearly', value: 'yearly' },
];

const SCOPES: ReadonlyArray<{ label: string; value: RecurringScope }> = [
  { label: 'This event', value: 'instance' },
  { label: 'This + following', value: 'following' },
  { label: 'All events', value: 'series' },
];

export type EditSeed = EventEditorSeed;

export function EventEditSheet({
  calendars,
  onClose,
  seed,
  timeZone,
}: {
  calendars: ReadonlyArray<CalendarInfo>;
  onClose: () => void;
  seed: EditSeed;
  timeZone: string;
}) {
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
    repeatInterval,
    respond,
    rsvp,
    save,
    scope,
    setCalendarKey,
    setDate,
    setEndTime,
    setIsAllDay,
    setLocation,
    setRepeat,
    setRepeatCount,
    setRepeatInterval,
    setScope,
    setStartTime,
    setTitle,
    startTime,
    title,
    writableCalendars: writable,
  } = useEventEditorModel({ calendars, onClose, seed, timeZone });

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="overFullScreen"
      visible
    >
      {/* overFullScreen draws under the status bar; inset it ourselves. */}
      <SafeAreaView style={styles.container}>
        <View style={styles.header}>
          <Pressable onPress={onClose}>
            <Text style={styles.cancel}>Cancel</Text>
          </Pressable>
          <Text style={styles.title}>{existing ? 'Edit Event' : 'New Event'}</Text>
          <Pressable onPress={() => void save()}>
            <Text style={styles.save}>Save</Text>
          </Pressable>
        </View>

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
                  <Text
                    style={[styles.scopeLabel, scope === option.value && styles.scopeLabelActive]}
                  >
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
                        style={[
                          styles.scopeLabel,
                          repeat === option.value && styles.scopeLabelActive,
                        ]}
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
                      <Text style={styles.label}>Ends after (blank = never)</Text>
                      <TextInput
                        keyboardType="number-pad"
                        onChangeText={setRepeatCount}
                        placeholder="occurrences"
                        style={styles.input}
                        value={repeatCount}
                      />
                    </View>
                  </View>
                )}
              </>
            )}

            <Text style={styles.label}>Date (YYYY-MM-DD)</Text>
            <TextInput
              autoCapitalize="none"
              onChangeText={setDate}
              style={styles.input}
              value={date}
            />
            {isAllDay ? null : (
              <View style={styles.timesRow}>
                <View style={styles.timeField}>
                  <Text style={styles.label}>Start (HH:MM)</Text>
                  <TextInput
                    autoCapitalize="none"
                    onChangeText={setStartTime}
                    style={styles.input}
                    value={startTime}
                  />
                </View>
                <View style={styles.timeField}>
                  <Text style={styles.label}>End (HH:MM)</Text>
                  <TextInput
                    autoCapitalize="none"
                    onChangeText={setEndTime}
                    style={styles.input}
                    value={endTime}
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
                          style={[
                            styles.scopeLabel,
                            rsvp === option.value && styles.scopeLabelActive,
                          ]}
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
              <Pressable onPress={() => void remove()} style={styles.deleteButton}>
                <Text style={styles.deleteLabel}>Delete Event</Text>
              </Pressable>
            ) : null}
          </>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  attendee: {
    color: palette.textMuted,
    fontSize: 14,
    paddingVertical: 2,
  },
  calendarName: {
    color: palette.textMuted,
    flex: 1,
    fontSize: 15,
  },
  calendarRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    paddingVertical: 6,
  },
  calendarSelected: {
    color: palette.text,
    fontWeight: '600',
  },
  cancel: {
    color: palette.textMuted,
    fontSize: 16,
  },
  check: {
    color: '#2563eb',
    fontSize: 16,
    fontWeight: '700',
  },
  container: {
    backgroundColor: palette.background,
    flex: 1,
  },
  content: {
    padding: 16,
  },
  deleteButton: {
    alignItems: 'center',
    borderColor: '#fecaca',
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 24,
    paddingVertical: 12,
  },
  deleteLabel: {
    color: '#dc2626',
    fontSize: 15,
    fontWeight: '600',
  },
  error: {
    color: '#b91c1c',
    fontSize: 13,
    marginBottom: 10,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 14,
  },
  input: {
    backgroundColor: '#ffffff',
    borderColor: palette.border,
    borderRadius: 10,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
    marginBottom: 12,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  joinButton: {
    alignItems: 'center',
    backgroundColor: '#16a34a',
    borderRadius: 10,
    marginBottom: 12,
    paddingVertical: 10,
  },
  joinLabel: {
    color: '#ffffff',
    fontSize: 15,
    fontWeight: '700',
  },
  label: {
    color: palette.textMuted,
    fontSize: 12,
    fontWeight: '600',
    marginBottom: 4,
    textTransform: 'uppercase',
  },
  notice: {
    backgroundColor: '#fef3c7',
    borderRadius: 10,
    color: '#92400e',
    fontSize: 14,
    padding: 12,
  },
  save: {
    color: '#2563eb',
    fontSize: 16,
    fontWeight: '700',
  },
  scopeChip: {
    borderColor: palette.border,
    borderRadius: 16,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  scopeChipActive: {
    backgroundColor: '#2563eb',
    borderColor: '#2563eb',
  },
  scopeLabel: {
    color: palette.textMuted,
    fontSize: 13,
    fontWeight: '600',
  },
  scopeLabelActive: {
    color: '#ffffff',
  },
  scopeRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 14,
  },
  swatch: {
    borderRadius: 4,
    height: 14,
    width: 14,
  },
  switchRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginVertical: 10,
  },
  timeField: {
    flex: 1,
  },
  timesRow: {
    flexDirection: 'row',
    gap: 12,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
  },
});
