import { parseQuickAdd, type LanguageModel } from '@calendar/ai';
import { Temporal, type CalendarInfo } from '@calendar/core';
import type { EventEditorPrefill } from '@calendar/app-state';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { palette } from './theme.ts';

/**
 * Natural-language capture: a phrase becomes a prefilled editor the user
 * confirms — nothing is written by the model. Hidden entirely when no
 * on-device model exists, leaving the manual `＋` flow untouched.
 */
export function QuickAddBar({
  calendars,
  model,
  onParsed,
  timeZone,
}: {
  calendars: ReadonlyArray<CalendarInfo>;
  model: LanguageModel;
  onParsed: (prefill: EventEditorPrefill) => void;
  timeZone: string;
}) {
  const [available, setAvailable] = useState<boolean | null>(null);
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void model.isAvailable().then((value) => {
      if (!cancelled) {
        setAvailable(value);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [model]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await parseQuickAdd(model, {
        calendarNames: calendars.map((calendar) => calendar.summary),
        phrase,
        referenceDate: Temporal.Now.plainDateISO(timeZone).toString(),
        timeZone,
      });
      if (result.kind === 'rejected') {
        setError(result.reason);
        return;
      }
      setPhrase('');
      onParsed(result.prefill);
    } catch {
      setError('On-device model unavailable.');
    } finally {
      setBusy(false);
    }
  };

  if (available !== true) {
    return null;
  }

  return (
    <View style={styles.container}>
      <View style={styles.row}>
        <TextInput
          editable={!busy}
          onChangeText={setPhrase}
          onSubmitEditing={() => void submit()}
          placeholder="Lunch with Sarah tomorrow at 1"
          returnKeyType="go"
          style={styles.input}
          testID="quick-add-input"
          value={phrase}
        />
        {busy ? (
          <ActivityIndicator style={styles.spinner} />
        ) : (
          <Pressable
            disabled={phrase.trim() === ''}
            onPress={() => void submit()}
            style={[styles.button, phrase.trim() === '' && styles.buttonDisabled]}
            testID="quick-add-submit"
          >
            <Text style={styles.buttonLabel}>Add</Text>
          </Pressable>
        )}
      </View>
      {error ? <Text style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  button: {
    backgroundColor: '#2563eb',
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  buttonDisabled: {
    opacity: 0.4,
  },
  buttonLabel: {
    color: '#ffffff',
    fontSize: 14,
    fontWeight: '600',
  },
  container: {
    borderBottomColor: palette.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingBottom: 8,
    paddingHorizontal: 12,
  },
  error: {
    color: '#b91c1c',
    fontSize: 12,
    marginTop: 6,
  },
  input: {
    borderColor: palette.border,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    fontSize: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  spinner: {
    paddingHorizontal: 18,
  },
});
