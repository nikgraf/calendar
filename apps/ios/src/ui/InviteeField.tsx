import { useInviteeField } from '@calendar/app-state';
import { emailKey, isValidEmail, type Attendee, type AttendeeInput } from '@calendar/core';
import { Effect } from 'effect';
import { useEffect } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { iosContactsClient } from '../contactsClient.ts';
import { sheetStyles as styles } from './editSheetShared.ts';

const STATUS_COLOR: Record<Attendee['responseStatus'], string> = {
  accepted: '#22c55e',
  declined: '#ef4444',
  needsAction: '#d4d4d4',
  tentative: '#f59e0b',
};

const contactsStatus = (): Promise<string> =>
  Effect.runPromise(
    iosContactsClient.status().pipe(Effect.orElseSucceed(() => 'unavailable' as const)),
  );

/**
 * Guest chips + a typeahead over device and Google contacts. Suggestions
 * render as plain pressables under the input (no FlatList inside the
 * sheet's ScrollView); the enclosing ScrollView keeps taps alive with
 * keyboardShouldPersistTaps so a suggestion tap is not eaten by the
 * keyboard dismissal. The state machine is useInviteeField, shared with
 * the desktop combobox: the query is debounced, rows for an earlier
 * query show dimmed and are never auto-picked, Return/comma/blur turn a
 * typed address into a chip, and Backspace on an empty field removes
 * the last chip.
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

  return (
    <View>
      {attendees.length > 0 ? (
        <View style={styles.chipRow}>
          {attendees.map((attendee) => {
            const status = attendeeStatus(attendee.email);
            return (
              <View key={emailKey(attendee.email)} style={styles.chip} testID="invitee-chip">
                <View
                  style={[
                    styles.chipDot,
                    { backgroundColor: STATUS_COLOR[status?.responseStatus ?? 'needsAction'] },
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
        returnKeyType="done"
        style={styles.input}
        testID="invitee-input"
        value={text}
      />
      {text.trim() !== '' ? (
        <View style={styles.suggestions}>
          {suggestions.map((contact) => (
            <Pressable
              accessibilityRole="button"
              key={contact.id}
              onPress={() => choose(contact)}
              style={[styles.suggestion, stale && styles.suggestionStale]}
            >
              <Text style={styles.suggestionTitle}>{contact.displayName ?? contact.email}</Text>
              {contact.displayName ? (
                <Text style={styles.suggestionMeta}>{contact.email}</Text>
              ) : null}
            </Pressable>
          ))}
          {suggestions.length === 0 && !stale ? (
            <Text style={styles.hint}>
              {isValidEmail(text) ? 'Tap Done to invite this address' : 'No matches'}
            </Text>
          ) : null}
        </View>
      ) : null}
      {permission === 'notDetermined' ? (
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void allow()}>
          <Text style={styles.webLink}>Allow access to Contacts to suggest people</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
