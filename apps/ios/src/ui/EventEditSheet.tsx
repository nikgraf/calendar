import { useEventEditorModel, useTaskEditorModel, type EventEditorSeed } from '@calendar/app-state';
import {
  type CalendarInfo,
  type RecurrenceFrequency,
  type RecurringScope,
  type RsvpResponse,
  type TaskListInfo,
  type TaskRecord,
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
import { useState } from 'react';
import DateTimePicker from '@react-native-community/datetimepicker';
import { palette } from './theme.ts';

/**
 * The editor model stores wall-clock strings (YYYY-MM-DD / HH:MM) shared
 * with desktop; the native pickers speak JS Date. On iOS the editor's
 * zone is the device zone, so local-time Dates round-trip exactly.
 * Degenerate strings fall back to today 09:00 — a picker must never
 * receive an Invalid Date.
 */
const dateFromParts = (date: string, time?: string): Date => {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = (time ?? '09:00').split(':').map(Number);
  if (!year || !month || !day) {
    return new Date();
  }
  const parsed = new Date(year, month - 1, day, hour ?? 9, minute ?? 0);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
};

const pad2 = (value: number) => String(value).padStart(2, '0');

const toDateString = (value: Date): string =>
  `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`;

const toTimeString = (value: Date): string =>
  `${pad2(value.getHours())}:${pad2(value.getMinutes())}`;

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

const REPEAT_ENDS: ReadonlyArray<{ label: string; value: 'after' | 'never' | 'on' }> = [
  { label: 'Never', value: 'never' },
  { label: 'After', value: 'after' },
  { label: 'On date', value: 'on' },
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
  task,
  taskLists,
  timeZone,
}: {
  calendars: ReadonlyArray<CalendarInfo>;
  onClose: () => void;
  seed: EditSeed;
  /** Present when the sheet was opened from a task chip (task edit mode). */
  task?: TaskRecord | undefined;
  taskLists: ReadonlyArray<TaskListInfo>;
  timeZone: string;
}) {
  // Create mode offers an Event | Task toggle; a chip tap fixes the mode.
  const [mode, setMode] = useState<'event' | 'task'>(task ? 'task' : 'event');
  const taskModel = useTaskEditorModel({
    onClose,
    seed: { existing: task, initialDate: seed.initialDate.toString() },
    taskLists,
  });
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
    save,
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
          <Text style={styles.title}>
            {mode === 'task'
              ? task
                ? 'Edit Task'
                : 'New Task'
              : existing
                ? 'Edit Event'
                : 'New Event'}
          </Text>
          <Pressable
            onPress={() => void (mode === 'task' ? taskModel.save() : save())}
            testID="event-save"
          >
            <Text style={styles.save}>Save</Text>
          </Pressable>
        </View>

        {!existing && !task ? (
          <View style={styles.modeRow}>
            {(['event', 'task'] as const).map((option) => (
              <Pressable
                key={option}
                onPress={() => setMode(option)}
                style={[styles.scopeChip, mode === option && styles.scopeChipActive]}
                testID={`mode-${option}`}
              >
                <Text style={[styles.scopeLabel, mode === option && styles.scopeLabelActive]}>
                  {option === 'event' ? 'Event' : 'Task'}
                </Text>
              </Pressable>
            ))}
          </View>
        ) : null}

        {mode === 'task' ? (
          <ScrollView contentContainerStyle={styles.content}>
            {taskModel.error ? <Text style={styles.error}>{taskModel.error}</Text> : null}
            <TextInput
              autoFocus={!task}
              onChangeText={taskModel.setTitle}
              placeholder="Title"
              style={styles.input}
              testID="task-title"
              value={taskModel.title}
            />

            <View style={styles.pickerRow}>
              <Text style={styles.label}>Due</Text>
              <DateTimePicker
                display="compact"
                mode="date"
                onChange={(_, picked) => picked && taskModel.setDueDate(toDateString(picked))}
                value={dateFromParts(taskModel.dueDate)}
              />
            </View>

            <Text style={styles.label}>List</Text>
            {taskModel.taskLists.map((list) => {
              const key = `${list.accountId}:${list.id}`;
              const selected = key === taskModel.listKey;
              return (
                <Pressable
                  // The list is fixed after create — moving needs tasks.move.
                  disabled={Boolean(task)}
                  key={key}
                  onPress={() => taskModel.setListKey(key)}
                  style={styles.calendarRow}
                  testID="task-list-option"
                >
                  <Text style={[styles.calendarName, selected && styles.calendarSelected]}>
                    {list.title}
                  </Text>
                  {selected ? <Text style={styles.check}>✓</Text> : null}
                </Pressable>
              );
            })}

            <Text style={styles.label}>Notes</Text>
            <TextInput
              multiline
              numberOfLines={3}
              onChangeText={taskModel.setNotes}
              placeholder="Add notes"
              style={[styles.input, styles.notesInput]}
              value={taskModel.notes}
            />

            {task?.webViewLink ? (
              <Pressable onPress={() => void Linking.openURL(task.webViewLink ?? '')}>
                <Text style={styles.webLink}>Open in Google Tasks</Text>
              </Pressable>
            ) : null}

            {task ? (
              <Pressable
                onPress={() => void taskModel.remove()}
                style={styles.deleteButton}
                testID="task-delete"
              >
                <Text style={styles.deleteLabel}>Delete Task</Text>
              </Pressable>
            ) : null}
          </ScrollView>
        ) : (
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
                        style={[
                          styles.scopeChip,
                          repeat === option.value && styles.scopeChipActive,
                        ]}
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
                          style={[
                            styles.scopeChip,
                            rsvp === option.value && styles.scopeChipActive,
                          ]}
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
        )}
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
  modeRow: {
    flexDirection: 'row',
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  notesInput: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  pickerRow: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
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
  timePicker: {
    alignSelf: 'flex-start',
  },
  timesRow: {
    flexDirection: 'row',
    gap: 12,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
  },
  webLink: {
    color: '#2563eb',
    fontSize: 14,
    marginTop: 4,
  },
});
