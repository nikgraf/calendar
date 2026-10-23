import {
  eventReadout,
  RSVP_OPTIONS,
  SCOPE_OPTIONS,
  useCurrentEvent,
  useEventEditorModel,
  useTimeZones,
} from '@calendar/app-state';
import {
  type CalendarInfo,
  draftZoneRanges,
  type EventRecord,
  formatPlainTime,
  type RecurringScope,
  type RsvpResponse,
  Temporal,
  utcMsToPlainDate,
} from '@calendar/core';
import { useEffect, useEffectEvent, useState } from 'react';
import { Linking, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { confirmEditorRequest } from './EventEditSheet.tsx';
import { actionText, BOX_FONT_SCALE, type ThemeColors, useEventTint, useStyles } from './theme.ts';
import { ZoneLines } from './ZoneLines.tsx';

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
 *
 * It follows its event, as the desktop inspector does: `event` is the
 * record as tapped, and the sheet shows the event as it is now — an edit
 * landing after it opened (a sync pass bringing another device's edit or
 * an agent's on the Mac) shows here, Edit and Convert start from it, and
 * an event that is gone closes the sheet. Everything shown is read from
 * that record (`eventReadout`); the editor model seeds its fields once,
 * when it mounts, and is here for the actions and their state (the scope,
 * the reply just given, an error).
 */
export function EventDetailSheet({
  calendars,
  event: opened,
  onClose,
  onConvert,
  onDeleted,
  onEdit,
  timeZone,
}: {
  calendars: ReadonlyArray<CalendarInfo>;
  event: EventRecord;
  onClose: () => void;
  /** Convert to a task: opens the editor in task mode on the event as it is now. */
  onConvert: (event: EventRecord) => void;
  /** Delete went through, with this scope: the event is gone, and with a series' scope its siblings. */
  onDeleted: (scope: RecurringScope) => void;
  /** Opens the editor on the event as it is now. */
  onEdit: (event: EventRecord) => void;
  timeZone: string;
}) {
  const styles = useStyles(makeStyles);
  const [event, setEvent] = useState(opened);
  const current = useCurrentEvent(event);
  if (current !== null && current !== event) {
    // Render-phase state adjustment (the React "derive from props" pattern).
    setEvent(current);
  }
  // Deleted (here, elsewhere, or a whole series): the last version seen
  // stays up until the sheet has gone. A read that failed is not "gone".
  const gone = current === null;
  const close = useEffectEvent(onClose);
  useEffect(() => {
    if (gone) {
      close();
    }
  }, [gone]);
  const model = useEventEditorModel({
    calendars,
    confirm: confirmEditorRequest,
    // Called only after Delete, from the render it was pressed in: that
    // render's scope is the one the delete ran with.
    onClose: () => onDeleted(model.scope),
    seed: { event, initialDate: Temporal.PlainDate.from(utcMsToPlainDate(event.startUtc)) },
    timeZone,
  });
  const { secondary: secondaryZones } = useTimeZones();
  const { canRsvp, error, isRecurring, joinUrl, readOnly, remove, respond, rsvp, scope, setScope } =
    model;
  const { attendees, date, description, endTime, isAllDay, location, startTime, title } =
    eventReadout(event, timeZone);
  const calendar = calendars.find(
    (candidate) => candidate.accountId === event.accountId && candidate.id === event.calendarId,
  );
  const tint = useEventTint(calendar?.colorHex ?? '#4285f4');
  const day = Temporal.PlainDate.from(date).toLocaleString('en-US', {
    day: 'numeric',
    month: 'long',
    weekday: 'long',
  });
  const zoneLines = draftZoneRanges(
    { date, endTime, isAllDay, startTime },
    timeZone,
    secondaryZones,
  );

  return (
    <Modal animationType="slide" onRequestClose={onClose} presentationStyle="pageSheet" visible>
      <View style={styles.container} testID="event-detail">
        <View style={styles.header}>
          <Pressable accessibilityRole="button" onPress={onClose} testID="event-detail-close">
            <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.cancel}>
              Close
            </Text>
          </Pressable>
          <View style={styles.calendarPill}>
            <View style={[styles.dot, { backgroundColor: tint.edge }]} />
            <Text
              maxFontSizeMultiplier={BOX_FONT_SCALE}
              numberOfLines={1}
              style={styles.calendarName}
            >
              {calendar?.summary ?? 'Calendar'}
            </Text>
          </View>
          <Pressable accessibilityRole="button" onPress={() => onEdit(event)} testID="event-edit">
            <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.edit}>
              Edit
            </Text>
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
            {zoneLines ? <ZoneLines lines={zoneLines} textStyle={styles.secondaryLine} /> : null}
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
              {attendees.map((attendee) => (
                <View key={attendee.email} style={styles.attendeeRow}>
                  <Text numberOfLines={1} selectable style={styles.primaryLine}>
                    {attendee.displayName ?? attendee.email}
                  </Text>
                  <Text style={styles.secondaryLine}>{STATUS_LABEL[attendee.responseStatus]}</Text>
                </View>
              ))}
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
              {/* A series converts as a whole, like it moves: Convert waits for "All events". */}
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: isRecurring && scope !== 'series' }}
                disabled={isRecurring && scope !== 'series'}
                onPress={() => onConvert(event)}
                style={[
                  styles.secondaryButton,
                  isRecurring && scope !== 'series' && styles.disabled,
                ]}
                testID="event-convert"
              >
                <Text style={styles.secondaryLabel}>
                  {isRecurring && scope !== 'series'
                    ? 'Convert to task (All events)'
                    : 'Convert to task'}
                </Text>
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
    disabled: {
      opacity: 0.4,
    },
    dot: {
      borderRadius: 5,
      height: 10,
      width: 10,
    },
    edit: {
      ...actionText(colors),
      fontSize: 16,
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
