import {
  RSVP_OPTIONS,
  SCOPE_OPTIONS,
  useEventEditorModel,
  useTimeZones,
} from '@calendar/app-state';
import {
  type CalendarInfo,
  draftZoneRange,
  type EventRecord,
  formatPlainTime,
  type RsvpResponse,
  Temporal,
  utcMsToPlainDate,
} from '@calendar/core';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { confirmEditorRequest } from './EventEditSheet.tsx';
import { type ThemeColors, useEventTint, useStyles } from './theme.ts';

const STATUS_LABEL: Record<string, string> = {
  accepted: 'accepted',
  declined: 'declined',
  needsAction: 'no reply',
  tentative: 'maybe',
};

/**
 * The read-first view of an event: a tap on the grid opens it, Edit opens
 * the editor. It answers the quick questions without a form — when,
 * where, who, the meeting link, the notes — and carries the actions that
 * need no form: RSVP, Convert to task and Delete (with the series scope
 * when the event repeats).
 */
export function EventDetailSheet({
  calendars,
  event,
  onClose,
  onConvert,
  onEdit,
  timeZone,
}: {
  calendars: ReadonlyArray<CalendarInfo>;
  event: EventRecord;
  onClose: () => void;
  onConvert: () => void;
  onEdit: () => void;
  timeZone: string;
}) {
  const styles = useStyles(makeStyles);
  const model = useEventEditorModel({
    calendars,
    confirm: confirmEditorRequest,
    onClose,
    seed: { event, initialDate: Temporal.PlainDate.from(utcMsToPlainDate(event.startUtc)) },
    timeZone,
  });
  const { secondary: secondaryZones } = useTimeZones();
  const {
    attendees,
    attendeeStatus,
    canRsvp,
    date,
    description,
    endTime,
    error,
    isAllDay,
    isRecurring,
    joinUrl,
    location,
    readOnly,
    remove,
    respond,
    rsvp,
    scope,
    setScope,
    startTime,
    title,
  } = model;
  const calendar = calendars.find(
    (candidate) => candidate.accountId === event.accountId && candidate.id === event.calendarId,
  );
  const tint = useEventTint(calendar?.colorHex ?? '#4285f4');
  const day = Temporal.PlainDate.from(date).toLocaleString('en-US', {
    day: 'numeric',
    month: 'long',
    weekday: 'long',
  });
  const zoneLine = draftZoneRange({ date, endTime, isAllDay, startTime }, timeZone, secondaryZones);

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible>
      <View style={styles.container} testID="event-detail">
        <View style={styles.header}>
          <Pressable accessibilityRole="button" onPress={onClose} testID="event-detail-close">
            <Text style={styles.cancel}>Close</Text>
          </Pressable>
          <View style={styles.calendarPill}>
            <View style={[styles.dot, { backgroundColor: tint.edge }]} />
            <Text numberOfLines={1} style={styles.calendarName}>
              {calendar?.summary ?? 'Calendar'}
            </Text>
          </View>
          <Pressable accessibilityRole="button" onPress={onEdit} testID="event-edit">
            <Text style={styles.edit}>Edit</Text>
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          <Text selectable style={styles.title} testID="event-detail-title">
            {title}
          </Text>
          <View style={styles.section}>
            <Text style={styles.primaryLine}>{day}</Text>
            <Text style={styles.secondaryLine}>
              {isAllDay ? 'All day' : `${formatPlainTime(startTime)} – ${formatPlainTime(endTime)}`}
            </Text>
            {zoneLine ? <Text style={styles.secondaryLine}>{zoneLine}</Text> : null}
            {isRecurring ? <Text style={styles.secondaryLine}>Repeating event</Text> : null}
          </View>
          {readOnly ? (
            <Text style={styles.note} testID="event-read-only">
              This calendar is read-only.
            </Text>
          ) : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
          {joinUrl ? (
            <Pressable
              accessibilityRole="button"
              onPress={() => void Linking.openURL(joinUrl)}
              style={styles.joinButton}
              testID="event-join"
            >
              <Text style={styles.joinLabel}>Join meeting</Text>
            </Pressable>
          ) : null}
          {location ? (
            <View style={styles.section}>
              <Text style={styles.label}>LOCATION</Text>
              <Text selectable style={styles.primaryLine}>
                {location}
              </Text>
            </View>
          ) : null}
          {attendees.length > 0 ? (
            <View style={styles.section}>
              <Text style={styles.label}>INVITEES</Text>
              {canRsvp ? (
                <View style={styles.chipRow}>
                  {RSVP_OPTIONS.map((option) => {
                    const active = rsvp === option.value;
                    return (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        key={option.value}
                        onPress={() => void respond(option.value as RsvpResponse)}
                        style={[styles.chip, active && styles.chipActive]}
                        testID={`rsvp-${option.value}`}
                      >
                        <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>
                          {option.label}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
              {attendees.map((attendee) => {
                const status = attendeeStatus(attendee.email);
                return (
                  <View key={attendee.email} style={styles.attendeeRow}>
                    <Text numberOfLines={1} selectable style={styles.primaryLine}>
                      {attendee.displayName ?? attendee.email}
                    </Text>
                    <Text style={styles.secondaryLine}>
                      {STATUS_LABEL[status?.responseStatus ?? 'needsAction']}
                    </Text>
                  </View>
                );
              })}
            </View>
          ) : null}
          {description ? (
            <View style={styles.section}>
              <Text style={styles.label}>NOTES</Text>
              <Text selectable style={styles.primaryLine} testID="event-detail-notes">
                {description}
              </Text>
            </View>
          ) : null}
          {readOnly ? null : (
            <View style={styles.actions}>
              {isRecurring ? (
                <View style={styles.chipRow}>
                  {SCOPE_OPTIONS.map((option) => {
                    const active = scope === option.value;
                    return (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        key={option.value}
                        onPress={() => setScope(option.value)}
                        style={[styles.chip, active && styles.chipActive]}
                      >
                        <Text style={[styles.chipLabel, active && styles.chipLabelActive]}>
                          {option.short}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              ) : null}
              <Pressable
                accessibilityRole="button"
                onPress={onConvert}
                style={styles.secondaryButton}
                testID="event-convert"
              >
                <Text style={styles.secondaryLabel}>Convert to task</Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                onPress={() => void remove()}
                style={styles.secondaryButton}
                testID="event-delete"
              >
                <Text style={styles.deleteLabel}>Delete</Text>
              </Pressable>
            </View>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    actions: {
      gap: 10,
      marginTop: 8,
    },
    attendeeRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 8,
      justifyContent: 'space-between',
    },
    calendarName: {
      color: colors['text-secondary'],
      fontSize: 13,
      maxWidth: 160,
    },
    calendarPill: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 6,
    },
    cancel: {
      color: colors['text-secondary'],
      fontSize: 16,
    },
    chip: {
      backgroundColor: colors.fill,
      borderRadius: 16,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    chipActive: {
      backgroundColor: colors.primary,
    },
    chipLabel: {
      color: colors['text-secondary'],
      fontSize: 14,
    },
    chipLabelActive: {
      color: colors['on-primary'],
    },
    chipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
    },
    container: {
      backgroundColor: colors.canvas,
      flex: 1,
    },
    content: {
      gap: 18,
      padding: 16,
      paddingBottom: 48,
    },
    deleteLabel: {
      color: colors.danger,
      fontSize: 15,
      fontWeight: '600',
    },
    dot: {
      borderRadius: 5,
      height: 10,
      width: 10,
    },
    edit: {
      color: colors.primary,
      fontSize: 16,
      fontWeight: '600',
    },
    error: {
      color: colors.danger,
      fontSize: 13,
    },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 16,
      paddingVertical: 14,
    },
    joinButton: {
      alignItems: 'center',
      backgroundColor: colors.primary,
      borderRadius: 10,
      paddingVertical: 12,
    },
    joinLabel: {
      color: colors['on-primary'],
      fontSize: 16,
      fontWeight: '600',
    },
    label: {
      color: colors['text-secondary'],
      fontSize: 12,
      fontWeight: '600',
      letterSpacing: 0.4,
    },
    note: {
      backgroundColor: colors.fill,
      borderRadius: 8,
      color: colors['text-secondary'],
      fontSize: 14,
      padding: 10,
    },
    primaryLine: {
      color: colors.text,
      fontSize: 16,
    },
    secondaryButton: {
      alignSelf: 'flex-start',
      backgroundColor: colors.fill,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    secondaryLabel: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '600',
    },
    secondaryLine: {
      color: colors['text-secondary'],
      fontSize: 14,
    },
    section: {
      gap: 4,
    },
    title: {
      color: colors.text,
      fontSize: 24,
      fontWeight: '700',
    },
  });
