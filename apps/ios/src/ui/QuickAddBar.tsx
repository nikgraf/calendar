import { useModelAvailability, useQuickAddModel, type QuickAddItem } from '@calendar/app-state';
import { SymbolView } from 'expo-symbols';
import { useEffect, useRef } from 'react';
import {
  AccessibilityInfo,
  ActivityIndicator,
  AppState,
  Keyboard,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { appleSpeech } from '../appleSpeech.ts';
import { languageModel } from '../model.ts';
import { BOX_FONT_SCALE, type ThemeColors, useStyles, useTheme } from './theme.ts';

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
 * dictated, fills the form below (Return, Apply, or a pause in
 * dictation). Nothing is written by the model itself, and without it the
 * field says why and the form below is still there. Find a time is the
 * event form's own tool (`FindTimeFields`). Dictation is hands-free: one
 * tap of the microphone, then each pause sends what was said and it
 * listens again, until the microphone is tapped, the field is typed into
 * or the form is edited by hand (`editKey`).
 *
 * The field, the microphone and Apply are one box, and nothing under it
 * moves while it works: dictation's hints and a failure show in the field
 * itself (its placeholder, red for a failure, Apply out of the way),
 * reading and transcribing as a spinner in Apply. A tap on a failed field
 * brings its words back, selected. `attached`: the thread's turns hang
 * under the box (`ThreadTurnList`), so its bottom corners are square.
 */
export function QuickAddBar({
  attached = false,
  autoFocus = true,
  editKey,
  fallbackDate,
  hold,
  onApply,
  onPhrase,
  placeholder = 'Lunch with Sarah tomorrow at 1',
  timeZone,
}: {
  /** The thread's turns hang under the field: one card with it. */
  attached?: boolean | undefined;
  /**
   * Take the focus once the sheet settled. Off in the half-height editor:
   * the keyboard would raise the sheet over the calendar it is half
   * height for; a tap on the field brings it.
   */
  autoFocus?: boolean | undefined;
  /** Moves at each edit made by hand in the form: hands-free dictation ends. */
  editKey?: number | undefined;
  /** Undated phrases land on this day (the editor's). */
  fallbackDate: string;
  /** The form is still taking the last phrase in: dictation waits to listen again. */
  hold?: boolean | undefined;
  onApply: (item: QuickAddItem) => void;
  /**
   * Takes the phrase over (the editor's draft thread): resolves a message
   * for the field, or nothing when it was taken — the field clears and the
   * keyboard goes, so the form shows what the words did.
   */
  onPhrase?: ((text: string) => Promise<string | undefined>) | undefined;
  /** The field's hint: a change once there are drafts. */
  placeholder?: string | undefined;
  timeZone: string;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const inputRef = useRef<TextInput>(null);
  const { checking, retry, status } = useModelAvailability(languageModel, onAppActive);
  const {
    busy,
    dismissError,
    endVoice,
    error,
    handsFree,
    heard,
    phrase,
    setPhrase,
    submit,
    toggleVoice,
    voice,
    voiceAvailable,
  } = useQuickAddModel({
    editKey,
    fallbackDate,
    hold,
    model: languageModel,
    onApply,
    onPhrase:
      onPhrase === undefined
        ? undefined
        : async (text) => {
            const message = await onPhrase(text);
            if (message === undefined) {
              Keyboard.dismiss();
            }
            return message;
          },
    speech: appleSpeech,
    timeZone,
  });

  // A build without the framework, or an OS too old for it, gives the
  // user nothing to act on; otherwise say why the field is missing — the
  // silence is what made this hard to diagnose. The form stays either way.
  const unavailable = status !== null && status !== 'ready';
  const working = busy || voice === 'transcribing';
  // What the field says instead of its words: dictation's hint, or why
  // the last phrase failed (until the field is tapped or typed into —
  // while listening, until the next phrase begins).
  const note: { readonly text: string; readonly tone: 'error' | 'hint' } | null =
    voice === 'preparing'
      ? { text: 'Preparing dictation…', tone: 'hint' }
      : !working && error
        ? { text: error, tone: 'error' }
        : voice === 'recording'
          ? { text: 'Listening… pause to send, tap the mic to stop', tone: 'hint' }
          : null;
  const failed = note?.tone === 'error';
  /** The failed words back in the field, selected, to fix or type over: dictation hands over. */
  const takeBack = () => {
    if (failed) {
      endVoice();
      dismissError();
      // After the tap has placed its caret, or it would win over the selection.
      setTimeout(() => inputRef.current?.setSelection(0, phrase.length), 120);
    }
  };
  // The placeholder is not read out when it changes: VoiceOver hears it here.
  const noteText = note?.text;
  useEffect(() => {
    if (noteText) {
      AccessibilityInfo.announceForAccessibility(noteText);
    }
  }, [noteText]);
  const explain = unavailable && status !== 'missing-module' && iosMajorVersion() >= MODEL_MIN_IOS;

  // The field is what a new item opens on. `autoFocus` inside a page
  // sheet is not reliable while it is still sliding in, so the focus is
  // asked for once the sheet has settled.
  useEffect(() => {
    if (status !== 'ready' || !autoFocus) {
      return;
    }
    const timer = setTimeout(() => inputRef.current?.focus(), 400);
    return () => clearTimeout(timer);
  }, [status, autoFocus]);

  // The marker renders once the availability check resolved, whatever it said.
  if (status === null) {
    return null;
  }
  return (
    <View style={[styles.bar, attached && styles.barAttached]} testID="quick-add-state">
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
          <View style={[styles.box, attached && styles.boxAttached]}>
            <TextInput
              accessibilityHint={note?.text}
              accessibilityLabel="Describe what to add"
              editable={!busy}
              onChangeText={(text) => {
                // Typed into while dictating: the user took over.
                if (handsFree) {
                  endVoice();
                }
                // Typed into a failed field: a new phrase, from the key pressed.
                dismissError();
                setPhrase(text);
              }}
              onFocus={takeBack}
              onPressIn={takeBack}
              onSubmitEditing={() => void submit()}
              placeholder={note?.text ?? placeholder}
              placeholderTextColor={failed ? colors.danger : colors['text-secondary']}
              ref={inputRef}
              returnKeyType="go"
              style={styles.input}
              testID="quick-add-input"
              value={note ? '' : phrase}
            />
            {voiceAvailable ? (
              <Pressable
                accessibilityLabel={handsFree ? 'Stop dictating' : 'Dictate'}
                accessibilityRole="button"
                accessibilityState={{ selected: handsFree }}
                // On, it always answers (to stop); off, not while a typed phrase is read.
                disabled={!handsFree && working}
                onPress={() => {
                  // The keyboard would hide the form the phrases fill.
                  if (!handsFree) {
                    Keyboard.dismiss();
                  }
                  toggleVoice();
                }}
                style={[
                  styles.mic,
                  handsFree && styles.micRecording,
                  !handsFree && working && styles.disabled,
                ]}
                testID="quick-add-mic"
              >
                {/* The desktop's microphone: a line icon, red while dictating, filled while it hears speech. */}
                <SymbolView
                  name={heard ? 'mic.fill' : 'mic'}
                  size={20}
                  tintColor={handsFree ? colors.danger : colors.text}
                  weight="medium"
                />
              </Pressable>
            ) : null}
            {/* Out of the way while the field says why it failed: the room is the message's. */}
            {failed ? null : (
              <Pressable
                accessibilityLabel={
                  voice === 'transcribing'
                    ? 'Transcribing'
                    : busy
                      ? 'Reading the phrase'
                      : 'Fill the form from the phrase'
                }
                accessibilityRole="button"
                accessibilityState={{ busy: working }}
                disabled={working || phrase.trim() === '' || voice === 'recording'}
                onPress={() => void submit()}
                style={[
                  styles.button,
                  !working && (phrase.trim() === '' || voice === 'recording') && styles.disabled,
                ]}
                testID="quick-add-apply"
              >
                {/* The label keeps the button's size while the spinner stands in for it. */}
                <Text
                  maxFontSizeMultiplier={BOX_FONT_SCALE}
                  style={[styles.buttonLabel, working && styles.hidden]}
                >
                  Apply
                </Text>
                {working ? (
                  <ActivityIndicator color={colors['on-primary']} style={styles.spinner} />
                ) : null}
              </Pressable>
            )}
          </View>
        </>
      )}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    bar: {
      gap: 6,
      paddingHorizontal: 16,
      paddingVertical: 4,
    },
    // Nothing between the field and the turns hanging under it.
    barAttached: {
      paddingBottom: 0,
    },
    // The field, the microphone and Apply in one box.
    box: {
      alignItems: 'center',
      backgroundColor: colors.fill,
      borderRadius: 10,
      flexDirection: 'row',
      gap: 2,
      paddingRight: 4,
    },
    // The turns hang under it: square at the bottom, no gap.
    boxAttached: {
      borderBottomLeftRadius: 0,
      borderBottomRightRadius: 0,
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
    hidden: {
      opacity: 0,
    },
    input: {
      color: colors.text,
      flex: 1,
      fontSize: 16,
      paddingHorizontal: 12,
      paddingVertical: 12,
    },
    mic: {
      alignItems: 'center',
      borderRadius: 8,
      height: 36,
      justifyContent: 'center',
      width: 36,
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
    // Over the hidden label, so Apply keeps its size while it reads.
    spinner: {
      bottom: 0,
      left: 0,
      position: 'absolute',
      right: 0,
      top: 0,
    },
  });
