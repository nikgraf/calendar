import { parseQuickAdd, type LanguageModel, type ModelStatus } from '@calendar/ai';
import { Temporal } from '@calendar/core';
import type { EventEditorPrefill } from '@calendar/app-state';
import { useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { palette } from './theme.ts';

/** Foundation Models exist from iOS 26; below that there is nothing to say. */
const MODEL_MIN_IOS = 26;

/** `Platform.Version` is a string like "26.0" on iOS, a number elsewhere. */
const iosMajorVersion = (): number => Number.parseInt(String(Platform.Version), 10);

const UNAVAILABLE_NOTICE =
  'Quick add needs Apple Intelligence. Switch it on in Settings → Apple Intelligence & Siri; ' +
  'its models can take a while to download after that.';

/**
 * Natural-language capture: a phrase becomes a prefilled editor the user
 * confirms — nothing is written by the model.
 *
 * With no model the bar used to vanish without a word, which is how a
 * phone with Apple Intelligence switched on still showed nothing and left
 * no way to tell why. It now explains itself wherever the user could
 * plausibly act, and hides only where they could not.
 */
export function QuickAddBar({
  focusedDate,
  model,
  onParsed,
  timeZone,
}: {
  focusedDate: Temporal.PlainDate;
  model: LanguageModel;
  onParsed: (prefill: EventEditorPrefill) => void;
  timeZone: string;
}) {
  const [status, setStatus] = useState<ModelStatus | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [checking, setChecking] = useState(false);
  const [phrase, setPhrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = () => {
      setChecking(true);
      void model
        .status()
        .then((value) => {
          if (!cancelled) {
            setStatus(value);
          }
        })
        .finally(() => {
          if (!cancelled) {
            setChecking(false);
          }
        });
    };
    check();
    // Apple Intelligence is switched on in Settings, which means leaving
    // the app: re-check on the way back so the bar appears without a
    // relaunch. Model downloads finish out of process too.
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active') {
        check();
      }
    });
    return () => {
      cancelled = true;
      subscription.remove();
    };
  }, [attempt, model]);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await parseQuickAdd(model, {
        // Undated phrases land on the day being viewed; relative ones still
        // resolve against today.
        fallbackDate: focusedDate.toString(),
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

  if (status === null) {
    // Nothing decided yet — rendering a marker now would let e2e read a
    // pending check as a settled answer.
    return null;
  }

  if (status !== 'ready') {
    // A build without the framework, or an OS too old for it, gives the
    // user nothing to act on, so stay out of the way. Otherwise say why
    // the bar is empty: the silence is what made this hard to diagnose.
    if (status === 'missing-module' || iosMajorVersion() < MODEL_MIN_IOS) {
      // The marker still renders so e2e can distinguish "checked, no
      // model" from "not checked yet" instead of racing the mount.
      return <View testID="quick-add-state" />;
    }
    return (
      <View style={styles.container} testID="quick-add-state">
        <View style={styles.row}>
          <Text style={styles.notice}>{UNAVAILABLE_NOTICE}</Text>
          <Pressable
            accessibilityLabel="Check for the on-device model again"
            accessibilityRole="button"
            disabled={checking}
            onPress={() => setAttempt((value) => value + 1)}
            style={[styles.button, checking && styles.buttonDisabled]}
            testID="quick-add-recheck"
          >
            <Text style={styles.buttonLabel}>Retry</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.container} testID="quick-add-state">
      <View style={styles.row}>
        <TextInput
          accessibilityLabel="Describe an event to add"
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
            accessibilityLabel="Add the described event"
            accessibilityRole="button"
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
  notice: {
    color: palette.textMuted,
    flex: 1,
    fontSize: 12,
    lineHeight: 16,
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
