import { useBackendMutations, useContactsSearch } from '@calendar/app-state';
import {
  emailKey,
  isValidEmail,
  type Attendee,
  type AttendeeInput,
  type Contact,
} from '@calendar/core';
import { Effect } from 'effect';
import { useEffect, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import { iosContactsClient } from '../contactsClient.ts';
import { sheetStyles as styles } from './editSheetShared.ts';

const STATUS_COLOR: Record<Attendee['responseStatus'], string> = {
  accepted: '#22c55e',
  declined: '#ef4444',
  needsAction: '#d4d4d4',
  tentative: '#f59e0b',
};

/**
 * Guest chips + a typeahead over device and Google contacts. Suggestions
 * render as plain pressables under the input (no FlatList inside the
 * sheet's ScrollView); the enclosing ScrollView keeps taps alive with
 * keyboardShouldPersistTaps so a suggestion tap is not eaten by the
 * keyboard dismissal. Return/blur turn a typed address into a chip.
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
  const [text, setText] = useState('');
  const [permission, setPermission] = useState<string>('unavailable');
  const [busy, setBusy] = useState(false);
  const mutations = useBackendMutations();

  useEffect(() => {
    let cancelled = false;
    void Effect.runPromise(
      iosContactsClient.status().pipe(Effect.orElseSucceed(() => 'unavailable' as const)),
    ).then((status) => {
      if (!cancelled) {
        setPermission(status);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const taken = new Set(attendees.map((attendee) => emailKey(attendee.email)));
  const search = useContactsSearch(text);
  const suggestions = search.contacts.filter((contact) => !taken.has(emailKey(contact.email)));

  const choose = (contact: Contact) => {
    onAdd({ displayName: contact.displayName, email: contact.email });
    setText('');
  };

  const addTyped = () => {
    const trimmed = text.trim();
    if (isValidEmail(trimmed)) {
      onAdd({ email: trimmed });
      setText('');
    }
  };

  const allow = async () => {
    setBusy(true);
    try {
      const result = await mutations.connectContacts(undefined);
      setPermission(result.granted ? 'authorized' : 'denied');
    } catch {
      setPermission('denied');
    } finally {
      setBusy(false);
    }
  };

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
        autoCapitalize="none"
        autoCorrect={false}
        blurOnSubmit={false}
        keyboardType="email-address"
        onBlur={addTyped}
        onChangeText={setText}
        onSubmitEditing={() => {
          // Rows for an earlier query are shown dimmed, never auto-picked.
          if (suggestions[0] && !search.stale && !isValidEmail(text)) {
            choose(suggestions[0]);
          } else {
            addTyped();
          }
        }}
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
              key={contact.id}
              onPress={() => choose(contact)}
              style={[styles.suggestion, search.stale && styles.suggestionStale]}
            >
              <Text style={styles.suggestionTitle}>{contact.displayName ?? contact.email}</Text>
              {contact.displayName ? (
                <Text style={styles.suggestionMeta}>{contact.email}</Text>
              ) : null}
            </Pressable>
          ))}
          {suggestions.length === 0 ? (
            <Text style={styles.hint}>
              {isValidEmail(text) ? 'Tap Done to invite this address' : 'No matches'}
            </Text>
          ) : null}
        </View>
      ) : null}
      {permission === 'notDetermined' ? (
        <Pressable disabled={busy} onPress={() => void allow()}>
          <Text style={styles.webLink}>Allow access to Contacts to suggest people</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
