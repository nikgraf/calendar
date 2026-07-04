import { useBackendMutations } from '@calendar/app-state';
import {
  plainDateToUtcMs,
  Temporal,
  toZonedDateTime,
  type CalendarInfo,
  type EventRecord,
  type RecurringScope,
} from '@calendar/core';
import { useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View,
} from 'react-native';
import { palette } from './theme.ts';

const SCOPES: ReadonlyArray<{ label: string; value: RecurringScope }> = [
  { label: 'This event', value: 'instance' },
  { label: 'This + following', value: 'following' },
  { label: 'All events', value: 'series' },
];

export interface EditSeed {
  readonly event?: EventRecord;
  readonly initialDate: Temporal.PlainDate;
}

const timeString = (epochMs: number, timeZone: string): string =>
  toZonedDateTime(epochMs, timeZone).toPlainTime().toString({ smallestUnit: 'minute' });

export function EventEditSheet({
  calendars,
  onClose,
  seed,
  timeZone,
}: {
  calendars: ReadonlyArray<CalendarInfo>;
  onClose: () => void;
  seed: EditSeed | null;
  timeZone: string;
}) {
  const mutations = useBackendMutations();
  const existing = seed?.event;
  const isRecurring = Boolean(existing && (existing.recurrence || existing.recurringEventId));
  const writable = calendars.filter(
    (calendar) => calendar.accessRole === 'owner' || calendar.accessRole === 'writer',
  );

  const [title, setTitle] = useState(existing?.title ?? '');
  const [calendarKey, setCalendarKey] = useState(
    existing
      ? `${existing.accountId}:${existing.calendarId}`
      : writable[0]
        ? `${writable[0].accountId}:${writable[0].id}`
        : '',
  );
  const [isAllDay, setIsAllDay] = useState(existing?.isAllDay ?? false);
  const [date, setDate] = useState(
    existing
      ? (existing.startDate ??
          toZonedDateTime(existing.startUtc, timeZone).toPlainDate().toString())
      : (seed?.initialDate.toString() ?? ''),
  );
  const [startTime, setStartTime] = useState(
    existing && !existing.isAllDay ? timeString(existing.startUtc, timeZone) : '09:00',
  );
  const [endTime, setEndTime] = useState(
    existing && !existing.isAllDay ? timeString(existing.endUtc, timeZone) : '10:00',
  );
  const [scope, setScope] = useState<RecurringScope>('instance');
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    const [accountId, calendarId] = calendarKey.split(':', 2);
    if (!accountId || !calendarId || !title.trim()) {
      setError('A title and calendar are required.');
      return;
    }
    try {
      const parsedDate = Temporal.PlainDate.from(date);
      const times = isAllDay
        ? {
            endDate: parsedDate.add({ days: 1 }).toString(),
            endUtc: plainDateToUtcMs(parsedDate.add({ days: 1 }).toString()),
            startDate: parsedDate.toString(),
            startUtc: plainDateToUtcMs(parsedDate.toString()),
          }
        : {
            endUtc: parsedDate
              .toZonedDateTime({
                plainTime: Temporal.PlainTime.from(endTime),
                timeZone,
              })
              .toInstant().epochMilliseconds,
            startTimeZone: timeZone,
            startUtc: parsedDate
              .toZonedDateTime({
                plainTime: Temporal.PlainTime.from(startTime),
                timeZone,
              })
              .toInstant().epochMilliseconds,
          };
      if (!isAllDay && times.endUtc <= times.startUtc) {
        setError('End must be after start.');
        return;
      }
      await (existing && isRecurring && existing.recurringEventId
        ? mutations.updateRecurring({
            accountId,
            calendarId,
            changes: { title: title.trim(), ...times },
            masterId: existing.recurringEventId,
            originalStartUtc: existing.originalStartUtc ?? existing.startUtc,
            scope,
          })
        : existing
          ? mutations.updateEvent({
              accountId,
              calendarId,
              changes: { isAllDay, title: title.trim(), ...times },
              eventId: existing.id,
            })
          : mutations.createEvent({
              accountId,
              calendarId,
              isAllDay,
              title: title.trim(),
              ...times,
            }));
      onClose();
    } catch (error) {
      setError(String(error));
    }
  };

  const remove = async () => {
    if (!existing) {
      return;
    }
    try {
      await (isRecurring && existing.recurringEventId
        ? mutations.deleteRecurring({
            accountId: existing.accountId,
            calendarId: existing.calendarId,
            masterId: existing.recurringEventId,
            originalStartUtc: existing.originalStartUtc ?? existing.startUtc,
            scope,
          })
        : mutations.deleteEvent({
            accountId: existing.accountId,
            calendarId: existing.calendarId,
            eventId: existing.id,
          }));
      onClose();
    } catch (error) {
      setError(String(error));
    }
  };

  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={seed !== null}
    >
      <View style={styles.container}>
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

            {existing?.attendees?.length ? (
              <>
                <Text style={styles.label}>Invitees</Text>
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
      </View>
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
