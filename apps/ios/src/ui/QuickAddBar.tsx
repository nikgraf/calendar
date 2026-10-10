import { useModelAvailability, useQuickAddModel, type QuickAddItem } from '@calendar/app-state';
import { useEffect, useRef } from 'react';
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
import { appleSpeech } from '../appleSpeech.ts';
import { languageModel } from '../model.ts';
import { BOX_FONT_SCALE, type ThemeColors, useStyles } from './theme.ts';

/** Foundation Models exist from iOS 26; below that there is nothing to say. */
const MODEL_MIN_IOS = 26;
/** `Platform.Version` is a string like "26.0" on iOS, a number elsewhere. */
const iosMajorVersion = (): number => Number.parseInt(String(Platform.Version), 10);

const UNAVAILABLE_NOTICE =
  'Quick add needs Apple Intelligence. Switch it on in Settings → Apple Intelligence & Siri; ' +
  'its models can take a while to download after that.';

/**
 * Apple Intelligence is switched on in Settings, which means leaving the
 * app: re-check on the way back so the field appears without a relaunch.
 * Model downloads finish out of process too.
 */
export const onAppActive = (onActive: () => void): (() => void) => {
  const subscription = AppState.addEventListener('change', (next) => {
    if (next === 'active') {
      onActive();
    }
  });
  return () => subscription.remove();
};

/**
 * The quick-add field on top of a new item's editor: a phrase, typed or
 * dictated, fills the form below (Return, Apply, or the end of a
 * dictation). Nothing is written by the model itself, and without it the
 * field says why and the form below is still there. Find a time is the
 * event form's own tool (`FindTimeFields`).
 */
export function QuickAddBar({
  fallbackDate,
  onApply,
  timeZone,
}: {
  /** Undated phrases land on this day (the editor's). */
  fallbackDate: string;
  onApply: (item: QuickAddItem) => void;
  timeZone: string;
}) {
  const styles = useStyles(makeStyles);
  const inputRef = useRef<TextInput>(null);
  const { checking, retry, status } = useModelAvailability(languageModel, onAppActive);
  const {
    busy,
    error,
    phrase,
    setPhrase,
    startRecording,
    stopRecording,
    submit,
    voice,
    voiceAvailable,
  } = useQuickAddModel({
    fallbackDate,
    model: languageModel,
    onApply,
    speech: appleSpeech,
    timeZone,
  });

  // A build without the framework, or an OS too old for it, gives the
  // user nothing to act on; otherwise say why the field is missing — the
  // silence is what made this hard to diagnose. The form stays either way.
  const unavailable = status !== null && status !== 'ready';
  const explain = unavailable && status !== 'missing-module' && iosMajorVersion() >= MODEL_MIN_IOS;

  // The field is what a new item opens on. `autoFocus` inside a page
  // sheet is not reliable while it is still sliding in, so the focus is
  // asked for once the sheet has settled.
  useEffect(() => {
    if (status !== 'ready') {
      return;
    }
    const timer = setTimeout(() => inputRef.current?.focus(), 400);
    return () => clearTimeout(timer);
  }, [status]);

  // The marker renders once the availability check resolved, whatever it said.
  if (status === null) {
    return null;
  }
  return (
    <View style={styles.bar} testID="quick-add-state">
      {explain ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText}>{UNAVAILABLE_NOTICE}</Text>
          <Pressable
            accessibilityLabel="Check for the on-device model again"
            accessibilityRole="button"
            disabled={checking}
            onPress={retry}
            style={[styles.secondaryButton, checking && styles.disabled]}
            testID="quick-add-recheck"
          >
            <Text style={styles.secondaryLabel}>Retry</Text>
          </Pressable>
        </View>
      ) : null}
      {unavailable ? null : (
        <>
          <Text style={styles.eyebrow}>Describe it</Text>
          <View style={styles.row}>
            <TextInput
              accessibilityLabel="Describe what to add"
              editable={!busy}
              onChangeText={setPhrase}
              onSubmitEditing={() => void submit()}
              placeholder="Lunch with Sarah tomorrow at 1"
              ref={inputRef}
              returnKeyType="go"
              style={styles.input}
              testID="quick-add-input"
              value={phrase}
            />
            {voiceAvailable && !busy && voice !== 'transcribing' ? (
              <Pressable
                accessibilityLabel={voice === 'recording' ? 'Stop dictating' : 'Dictate'}
                accessibilityRole="button"
                disabled={voice === 'preparing'}
                onPress={() => void (voice === 'recording' ? stopRecording() : startRecording())}
                style={[styles.mic, voice === 'recording' && styles.micRecording]}
                testID="quick-add-mic"
              >
                <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.micLabel}>
                  {voice === 'recording' ? '■' : '🎙'}
                </Text>
              </Pressable>
            ) : null}
            {busy || voice === 'transcribing' || voice === 'preparing' ? (
              <ActivityIndicator style={styles.spinner} />
            ) : (
              <Pressable
                accessibilityLabel="Fill the form from the phrase"
                accessibilityRole="button"
                disabled={phrase.trim() === '' || voice === 'recording'}
                onPress={() => void submit()}
                style={[
                  styles.button,
                  (phrase.trim() === '' || voice === 'recording') && styles.disabled,
                ]}
                testID="quick-add-apply"
              >
                <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.buttonLabel}>
                  Apply
                </Text>
              </Pressable>
            )}
          </View>
          {voice === 'preparing' ? (
            <Text style={styles.hint}>Preparing dictation…</Text>
          ) : voice === 'recording' ? (
            <Text style={styles.hint}>Listening — tap ■ when finished.</Text>
          ) : voice === 'transcribing' ? (
            <Text style={styles.hint}>Transcribing…</Text>
          ) : null}
          {error ? <Text style={styles.error}>{error}</Text> : null}
        </>
      )}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    bar: {
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 8,
    },
    button: {
      backgroundColor: colors.primary,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    buttonLabel: {
      color: colors['on-primary'],
      fontSize: 15,
      fontWeight: '600',
    },
    disabled: {
      opacity: 0.4,
    },
    error: {
      color: colors.danger,
      fontSize: 13,
    },
    eyebrow: {
      color: colors.primary,
      fontSize: 12,
      fontWeight: '600',
    },
    hint: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    input: {
      backgroundColor: colors.fill,
      borderRadius: 10,
      color: colors.text,
      flex: 1,
      fontSize: 16,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    mic: {
      alignItems: 'center',
      backgroundColor: colors.fill,
      borderRadius: 10,
      height: 40,
      justifyContent: 'center',
      width: 40,
    },
    micLabel: {
      fontSize: 16,
    },
    micRecording: {
      backgroundColor: colors['event-blush'],
    },
    notice: {
      backgroundColor: colors.fill,
      borderRadius: 12,
      gap: 10,
      padding: 14,
    },
    noticeText: {
      color: colors['text-secondary'],
      fontSize: 14,
    },
    row: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 8,
    },
    secondaryButton: {
      alignSelf: 'flex-start',
      backgroundColor: colors.surface,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    secondaryLabel: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '600',
    },
    spinner: {
      marginHorizontal: 8,
    },
  });
