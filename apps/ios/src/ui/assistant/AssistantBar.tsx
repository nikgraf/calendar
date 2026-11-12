import type { ModelStatus } from '@calendar/ai';
import type { useQuickAddModel } from '@calendar/app-state';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  Keyboard,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputInstance,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { modelFixture } from '../../model.ts';
import { BOX_FONT_SCALE, type ThemeColors, useStyles, useTheme } from '../theme.ts';
import { useKeyboardInset } from './useKeyboardInset.ts';

type Quick = ReturnType<typeof useQuickAddModel>;

/**
 * What the bar is doing, or why the last phrase failed (until the field
 * is typed into — while listening, until the next phrase begins).
 */
const barStatus = ({
  busy,
  error,
  voice,
}: Pick<Quick, 'busy' | 'error' | 'voice'>): {
  readonly text: string;
  readonly tone: 'error' | 'hint';
} | null => {
  if (voice === 'preparing') {
    return { text: 'Preparing dictation…', tone: 'hint' };
  }
  if (voice === 'transcribing') {
    return { text: 'Transcribing…', tone: 'hint' };
  }
  if (busy) {
    return { text: 'Reading…', tone: 'hint' };
  }
  if (error) {
    return { text: error, tone: 'error' };
  }
  return voice === 'recording'
    ? { text: 'Listening… pause to send, tap the mic to stop', tone: 'hint' }
    : null;
};

/**
 * The Assistant's bar, at the bottom by the thumb: Type, the microphone,
 * Form. Speaking is the way in — one tap of the microphone listens, each
 * pause sends what was said and it listens again, until it is tapped
 * again or the form is edited by hand (`useQuickAddModel`). Type swaps
 * the bar for a field with a send button, riding above the keyboard; the
 * field giving up the focus (the keyboard dismissed, a phrase taken)
 * brings the bar back, its words kept. The focus, not the keyboard: on
 * the iOS 27 simulator XCTest's typing hides the keyboard under a field
 * that still has it. Form goes to the fields, on the
 * same draft. What it is doing, and why a phrase failed, is a line above
 * it; a failed phrase stays in the field to fix. Without the model, or
 * while an older step is on show, there is nothing to say to: only Form
 * answers. The marker id says the availability check resolved, and under
 * which model (the flows wait for it).
 */
export function AssistantBar({
  hasDrafts,
  onForm,
  previewing,
  quick,
  startTyping = false,
  status: modelStatus,
}: {
  readonly hasDrafts: boolean;
  /** To the form, on the same draft. */
  readonly onForm: () => void;
  /** An older step is on show: nothing is said to it. */
  readonly previewing: boolean;
  readonly quick: Quick;
  /** Open on the field, its words ready to send (the Create lesson's phrase). */
  readonly startTyping?: boolean | undefined;
  readonly status: ModelStatus | null;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const keyboard = useKeyboardInset();
  const {
    busy,
    dismissError,
    endVoice,
    handsFree,
    heard,
    phrase,
    setPhrase,
    submit,
    toggleVoice,
    voice,
    voiceAvailable,
  } = quick;
  const [typing, setTyping] = useState(startTyping);
  const input = useRef<TextInputInstance>(null);
  // Opened on the field: `autoFocus` is not reliable while the sheet is
  // still sliding in, so the focus is asked for once it has settled.
  const ready = modelStatus === 'ready';
  useEffect(() => {
    if (!startTyping || !ready) {
      return undefined;
    }
    const timer = setTimeout(() => input.current?.focus(), 400);
    return () => clearTimeout(timer);
  }, [ready, startTyping]);
  const unavailable = modelStatus !== null && modelStatus !== 'ready';
  const off = unavailable || previewing;
  const working = busy || voice === 'transcribing';
  const status = barStatus(quick);

  // The line is not read out when it changes: VoiceOver hears it here.
  const statusText = status?.text;
  useEffect(() => {
    if (statusText) {
      AccessibilityInfo.announceForAccessibility(statusText);
    }
  }, [statusText]);
  // An older step put on show while typing: the field has nothing to send to.
  if (typing && off) {
    setTyping(false);
  }

  if (modelStatus === null) {
    return null;
  }
  return (
    <View
      style={[styles.bar, { paddingBottom: keyboard > 0 ? keyboard + 8 : insets.bottom + 6 }]}
      testID={modelFixture ? 'quick-add-state-fixture' : 'quick-add-state'}
    >
      <Text
        accessibilityLiveRegion="polite"
        numberOfLines={2}
        style={[styles.status, status?.tone === 'error' && styles.statusError]}
        testID="quick-add-status"
      >
        {previewing ? 'An earlier step is on show' : (status?.text ?? '')}
      </Text>
      {typing ? (
        <View style={styles.field}>
          <TextInput
            accessibilityLabel={hasDrafts ? 'Describe a change' : 'Describe what to add'}
            autoFocus
            editable={!busy}
            // The keyboard dismissed, or the phrase taken: back to the bar.
            onBlur={() => setTyping(false)}
            onChangeText={(text) => {
              // Typed into while dictating: the user took over.
              if (handsFree) {
                endVoice();
              }
              // Typed into after a phrase failed: a new phrase, from the key pressed.
              dismissError();
              setPhrase(text);
            }}
            onSubmitEditing={() => void submit()}
            placeholder={hasDrafts ? 'Type a change' : 'Lunch with Sarah tomorrow at 1'}
            placeholderTextColor={colors['text-secondary']}
            ref={input}
            returnKeyType="send"
            style={styles.input}
            submitBehavior="submit"
            testID="quick-add-input"
            value={busy ? '' : phrase}
          />
          <Pressable
            accessibilityLabel="Send"
            accessibilityRole="button"
            accessibilityState={{ busy: working, disabled: working || phrase.trim() === '' }}
            disabled={working || phrase.trim() === ''}
            onPress={() => void submit()}
            style={[styles.send, (working || phrase.trim() === '') && styles.disabled]}
            testID="quick-add-apply"
          >
            {working ? (
              <ActivityIndicator color={colors['on-primary']} size="small" />
            ) : (
              <SymbolView
                name="arrow.up"
                size={18}
                tintColor={colors['on-primary']}
                weight="semibold"
              />
            )}
          </Pressable>
        </View>
      ) : (
        <View style={styles.row}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: off }}
            disabled={off}
            onPress={() => setTyping(true)}
            style={[styles.type, off && styles.disabled]}
            testID="quick-add-type"
          >
            <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.typeLabel}>
              Type
            </Text>
          </Pressable>
          {voiceAvailable ? (
            <Pressable
              accessibilityLabel={handsFree ? 'Stop dictating' : 'Dictate'}
              accessibilityRole="button"
              accessibilityState={{ selected: handsFree }}
              // On, it always answers (to stop); off, not while a typed phrase is read.
              disabled={off || (!handsFree && working)}
              onPress={() => {
                if (!handsFree) {
                  Keyboard.dismiss();
                }
                toggleVoice();
              }}
              style={[
                styles.mic,
                handsFree && styles.micOn,
                (off || (!handsFree && working)) && styles.disabled,
              ]}
              testID="quick-add-mic"
            >
              {working && !handsFree ? (
                <ActivityIndicator color={colors['on-primary']} />
              ) : (
                <SymbolView
                  name={heard ? 'mic.fill' : 'mic'}
                  size={30}
                  tintColor={handsFree ? colors['on-danger'] : colors['on-primary']}
                  weight="medium"
                />
              )}
            </Pressable>
          ) : (
            // No dictation on this device: typing is the way in.
            <View style={styles.micGap} />
          )}
          <Pressable
            accessibilityLabel="Form"
            accessibilityRole="button"
            onPress={onForm}
            style={styles.form}
            testID="editor-view-form"
          >
            <SymbolView
              name="rectangle.grid.1x2"
              size={17}
              tintColor={colors.text}
              weight="medium"
            />
            <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.formLabel}>
              Form
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    bar: {
      gap: 4,
      paddingHorizontal: 16,
      paddingTop: 4,
    },
    disabled: {
      opacity: 0.35,
    },
    field: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 24,
      flexDirection: 'row',
      gap: 8,
      minHeight: 48,
      paddingLeft: 16,
      paddingRight: 6,
    },
    form: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 22,
      flexDirection: 'row',
      gap: 8,
      height: 44,
      justifyContent: 'center',
      shadowColor: '#000000',
      shadowOffset: { height: 2, width: 0 },
      shadowOpacity: 0.1,
      shadowRadius: 8,
      width: 104,
    },
    formLabel: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '600',
    },
    input: {
      color: colors.text,
      flex: 1,
      fontSize: 17,
      paddingVertical: 12,
    },
    /** The way in: a thumb-sized disc in the ink of an action, ringed. */
    mic: {
      alignItems: 'center',
      backgroundColor: colors.primary,
      borderColor: colors.highlight,
      borderRadius: 42,
      borderWidth: 6,
      height: 84,
      justifyContent: 'center',
      width: 84,
    },
    micGap: {
      height: 84,
      width: 84,
    },
    micOn: {
      backgroundColor: colors.danger,
    },
    row: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingHorizontal: 12,
    },
    send: {
      alignItems: 'center',
      backgroundColor: colors.primary,
      borderRadius: 18,
      height: 36,
      justifyContent: 'center',
      width: 36,
    },
    status: {
      color: colors['text-secondary'],
      fontSize: 13,
      lineHeight: 18,
      minHeight: 18,
      textAlign: 'center',
    },
    statusError: {
      color: colors.danger,
    },
    type: {
      justifyContent: 'center',
      minHeight: 44,
      width: 104,
    },
    typeLabel: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '600',
    },
  });
