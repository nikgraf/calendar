import type { ModelStatus } from '@calendar/ai';
import type { useQuickAddModel } from '@calendar/app-state';
import { LESSON_DEMO_PHRASES } from '@calendar/core';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef } from 'react';
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
  type ViewStyle,
} from 'react-native';
import Animated, { type AnimatedStyle } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { modelFixture } from '../../model.ts';
import { BOX_FONT_SCALE, type ThemeColors, useStyles, useTheme } from '../theme.ts';
import { BAR_CAPSULE_WIDTH } from './SwitchCapsule.tsx';
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
 * The Create lesson's demo, while the Assistant's model is not on this
 * iPhone: the phrase it answers next; once it said both, the Form (an
 * iPhone that cannot run the model) or the wait for the model.
 */
export type BarDemo =
  | { readonly kind: 'form'; readonly onForm: () => void }
  | { readonly kind: 'phrase'; readonly phrase: string }
  | { readonly kind: 'wait' };

/**
 * Whether the demo takes the bar's place: its next phrase, or the Form
 * once it is through on an iPhone that cannot run the model (the sheet's
 * capsule leaves meanwhile). Not while an older step is on show.
 */
export const demoHoldsBar = (demo: BarDemo | undefined, previewing: boolean): boolean =>
  demo !== undefined && !previewing && demo.kind !== 'wait';

/** Said once the demo is through and the model is still on its way. */
const DEMO_WAIT = 'The Assistant answers anything once its model is here.';

/** The line over the bar: an older step on show, what it is doing, or the demo through and waiting. */
const barLine = ({
  demo,
  previewing,
  status,
}: {
  readonly demo: BarDemo | undefined;
  readonly previewing: boolean;
  readonly status: string | undefined;
}): string => {
  if (previewing) {
    return 'An earlier step is on show';
  }
  return status ?? (demo?.kind === 'wait' ? DEMO_WAIT : '');
};

/**
 * The demo's part of the bar: its next phrase in a field that sends it as
 * the field would (the words are the lesson's, not to be typed over), or,
 * on an iPhone that cannot run the model, the Form once both were said.
 */
function DemoBar({
  demo,
  onSend,
  working,
}: {
  readonly demo: Exclude<BarDemo, { readonly kind: 'wait' }>;
  readonly onSend: (phrase: string) => void;
  readonly working: boolean;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  if (demo.kind === 'form') {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={demo.onForm}
        style={({ pressed }) => [styles.formButton, pressed && styles.pressed]}
        testID="lesson-open-form"
      >
        <SymbolView name="rectangle.grid.1x2" size={18} tintColor={colors['on-primary']} />
        <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.formButtonLabel}>
          Open in the Form
        </Text>
      </Pressable>
    );
  }
  const next = demo.phrase;
  return (
    <View style={styles.demo}>
      <Text style={styles.demoLabel}>
        {next === LESSON_DEMO_PHRASES[0] ? 'DEMO · THIS PHRASE' : 'DEMO · NOW A CHANGE TO IT'}
      </Text>
      <View style={styles.field} testID="quick-add-demo">
        <Text style={styles.demoPhrase} testID="quick-add-demo-phrase">
          {next}
        </Text>
        <Pressable
          accessibilityLabel="Send"
          accessibilityRole="button"
          accessibilityState={{ busy: working, disabled: working }}
          disabled={working}
          onPress={() => onSend(next)}
          style={[styles.send, working && styles.disabled]}
          testID="quick-add-demo-send"
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
    </View>
  );
}

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
  demo,
  hasDrafts,
  micStyle,
  onTyping,
  previewing,
  quick,
  startTyping = false,
  status: modelStatus,
  typing: typingAsked,
}: {
  /** The Create lesson's demo, while the model is not here (`BarDemo`). */
  readonly demo?: BarDemo | undefined;
  readonly hasDrafts: boolean;
  /** The switch's motion for the microphone: it shrinks into the capsule's on the way to the form. */
  readonly micStyle: AnimatedStyle<ViewStyle>;
  /** The field opened, or given up (the sheet keeps it: the capsule leaves while it is open). */
  readonly onTyping: (typing: boolean) => void;
  /** An older step is on show: nothing is said to it. */
  readonly previewing: boolean;
  readonly quick: Quick;
  /** Open on the field, its words ready to send (the Create lesson's phrase). */
  readonly startTyping?: boolean | undefined;
  readonly status: ModelStatus | null;
  /** The field is open in place of the bar. */
  readonly typing: boolean;
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
  const typing = typingAsked && !off;
  // The demo's phrase, or its way on to the Form, in place of the bar;
  // through and waiting for the model, the bar as it is without one.
  const line = barLine({ demo, previewing, status: status?.text });

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
        {line}
      </Text>
      {demo !== undefined && demo.kind !== 'wait' && !previewing ? (
        <DemoBar demo={demo} onSend={(text) => void submit(text)} working={working} />
      ) : typing ? (
        <View style={styles.field}>
          <TextInput
            accessibilityLabel={hasDrafts ? 'Describe a change' : 'Describe what to add'}
            autoFocus
            editable={!busy}
            // The keyboard dismissed, or the phrase taken: back to the bar.
            onBlur={() => onTyping(false)}
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
            onPress={() => onTyping(true)}
            style={[styles.capsule, off && styles.disabled]}
            testID="quick-add-type"
          >
            <SymbolView name="keyboard" size={18} tintColor={colors.text} weight="medium" />
            <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.capsuleLabel}>
              Type
            </Text>
          </Pressable>
          {voiceAvailable ? (
            <Animated.View style={micStyle}>
              <Pressable
                accessibilityLabel={handsFree ? 'Stop dictating' : 'Dictate'}
                accessibilityRole="button"
                accessibilityState={{ selected: handsFree }}
                // On, it always answers (to stop); off, not while a typed phrase
                // is read, without the model or with an older step on show.
                disabled={!handsFree && (off || working)}
                onPress={() => {
                  if (!handsFree) {
                    Keyboard.dismiss();
                  }
                  toggleVoice();
                }}
                style={[
                  styles.mic,
                  handsFree && styles.micOn,
                  !handsFree && (off || working) && styles.disabled,
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
            </Animated.View>
          ) : (
            // No dictation on this device: typing is the way in.
            <View style={styles.micGap} />
          )}
          {/* Form's place: the sheet's one capsule sits here (`SwitchCapsule`), and stays while the views switch. */}
          <View style={styles.capsuleGap} />
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
    /** The demo's label over its field. */
    demo: {
      gap: 6,
    },
    demoLabel: {
      color: colors['text-secondary'],
      fontSize: 12,
      fontWeight: '600',
      letterSpacing: 0.3,
      paddingHorizontal: 8,
    },
    demoPhrase: {
      color: colors.text,
      flex: 1,
      fontSize: 17,
      paddingVertical: 12,
    },
    disabled: {
      opacity: 0.35,
    },
    /** Past the demo on an iPhone that cannot run the model: the way on, in the ink of an action. */
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
    formButton: {
      alignItems: 'center',
      backgroundColor: colors.primary,
      borderRadius: 25,
      flexDirection: 'row',
      gap: 8,
      justifyContent: 'center',
      minHeight: 50,
    },
    formButtonLabel: {
      color: colors['on-primary'],
      fontSize: 16,
      fontWeight: '600',
    },
    pressed: {
      opacity: 0.7,
    },
    /** Type and Form: two quiet capsules either side of the microphone, the one loud control. */
    capsule: {
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
    capsuleGap: {
      height: 44,
      width: BAR_CAPSULE_WIDTH,
    },
    capsuleLabel: {
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
  });
