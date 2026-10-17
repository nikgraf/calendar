import { useInviteeField } from '@calendar/app-state';
import { emailKey, isValidEmail, type Attendee, type AttendeeInput } from '@calendar/core';
import { Effect } from 'effect';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { iosContactsClient } from '../contactsClient.ts';
import { ActionRow, Row, Rows, RowSlot } from './GroupedList.tsx';
import { type ThemeColors, useStyles, useTheme } from './theme.ts';

const statusColor = (colors: ThemeColors): Record<Attendee['responseStatus'], string> => ({
  accepted: colors.success,
  declined: colors.danger,
  needsAction: colors.border,
  tentative: colors.warning,
});

const contactsStatus = (): Promise<string> =>
  Effect.runPromise(
    iosContactsClient.status().pipe(Effect.orElseSucceed(() => 'unavailable' as const)),
  );

/**
 * The invitees card's rows: the guest chips with the field under them in
 * one row, then the typeahead's matches over device and Google contacts
 * as rows (no FlatList inside the sheet's ScrollView; the enclosing
 * ScrollView keeps taps alive with keyboardShouldPersistTaps so a
 * suggestion tap is not eaten by the keyboard dismissal), and the way to
 * allow Contacts while it has not been asked. The state machine is
 * useInviteeField, shared with the desktop combobox: the query is
 * debounced, rows for an earlier query show dimmed and are never
 * auto-picked, Return/comma/blur turn a typed address into a chip, and
 * Backspace on an empty field removes the last chip.
 */
export function InviteeField({
  attendees,
  attendeeStatus,
  onAdd,
  onRemove,
}: {
  attendees: ReadonlyArray<AttendeeInput>;
  attendeeStatus: (email: string) => Attendee | undefined;
  onAdd: (input: AttendeeInput) => boolean;
  onRemove: (email: string) => void;
}) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const {
    acceptEnter,
    addTyped,
    allow,
    busy,
    choose,
    loadPermission,
    permission,
    removeLast,
    setText,
    stale,
    suggestions,
    text,
  } = useInviteeField({
    attendees,
    contactsStatus,
    isProtected: (email) => attendeeStatus(email)?.isOrganizer === true,
    onAdd,
    onRemove,
  });

  useEffect(() => {
    void loadPermission();
    // Once, on mount: the permission only changes through `allow`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const typing = text.trim() !== '';
  return (
    <Rows>
      <RowSlot>
        {attendees.length > 0 ? (
          <View style={styles.chipRow}>
            {attendees.map((attendee) => {
              const status = attendeeStatus(attendee.email);
              return (
                <View key={emailKey(attendee.email)} style={styles.chip} testID="invitee-chip">
                  <View
                    style={[
                      styles.chipDot,
                      {
                        backgroundColor:
                          statusColor(colors)[status?.responseStatus ?? 'needsAction'],
                      },
                    ]}
                  />
                  <Text style={styles.chipLabel}>{attendee.displayName ?? attendee.email}</Text>
                  {status?.isOrganizer ? (
                    <Text style={styles.chipMeta}>organizer</Text>
                  ) : (
                    <Pressable
                      accessibilityLabel={`Remove ${attendee.email}`}
                      accessibilityRole="button"
                      hitSlop={8}
                      onPress={() => onRemove(attendee.email)}
                    >
                      <Text style={styles.chipRemove}>×</Text>
                    </Pressable>
                  )}
                </View>
              );
            })}
          </View>
        ) : null}
        <TextInput
          accessibilityLabel="Invitees"
          autoCapitalize="none"
          autoCorrect={false}
          blurOnSubmit={false}
          keyboardType="email-address"
          onBlur={addTyped}
          onChangeText={(next) => {
            // A comma accepts the address typed before it, like desktop.
            if (next.endsWith(',') && isValidEmail(next.slice(0, -1).trim())) {
              setText(next.slice(0, -1));
              queueMicrotask(addTyped);
              return;
            }
            setText(next);
          }}
          onKeyPress={({ nativeEvent }) => {
            if (nativeEvent.key === 'Backspace') {
              removeLast();
            }
          }}
          onSubmitEditing={acceptEnter}
          placeholder="Add guests"
          placeholderTextColor={colors['text-secondary']}
          returnKeyType="done"
          style={styles.input}
          testID="invitee-input"
          value={text}
        />
      </RowSlot>
      {typing
        ? suggestions.map((contact) => (
            <Row
              disabled={stale}
              key={contact.id}
              onPress={() => choose(contact)}
              subtitle={contact.displayName ? contact.email : undefined}
              title={contact.displayName ?? contact.email}
            />
          ))
        : null}
      {typing && suggestions.length === 0 && !stale ? (
        <RowSlot>
          <Text style={styles.hint}>
            {isValidEmail(text) ? 'Tap Done to invite this address' : 'No matches'}
          </Text>
        </RowSlot>
      ) : null}
      {permission === 'notDetermined' ? (
        <ActionRow
          disabled={busy}
          onPress={() => void allow()}
          title="Allow access to Contacts to suggest people"
        />
      ) : null}
    </Rows>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    chip: {
      alignItems: 'center',
      backgroundColor: colors.fill,
      borderRadius: 999,
      flexDirection: 'row',
      gap: 6,
      paddingHorizontal: 10,
      paddingVertical: 5,
    },
    chipDot: {
      borderRadius: 4,
      height: 8,
      width: 8,
    },
    chipLabel: {
      color: colors.text,
      fontSize: 15,
    },
    chipMeta: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    chipRemove: {
      color: colors['text-secondary'],
      fontSize: 17,
      paddingHorizontal: 2,
    },
    chipRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
    },
    hint: {
      color: colors['text-secondary'],
      fontSize: 15,
    },
    // A 17 pt line in the slot's own padding makes the row's height.
    input: {
      color: colors.text,
      fontSize: 17,
      paddingVertical: 2,
    },
  });
