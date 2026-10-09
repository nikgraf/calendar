import { CAPTURE_MODEL_UNAVAILABLE, type CaptureState } from '@calendar/app-state';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { type ThemeColors, useStyles } from './theme.ts';
import { announce, NOTICE_GAP } from './Toast.tsx';

/**
 * Progress and errors of a capture, as a banner rather than a sheet: a
 * single extracted event opens the editor directly, and a sheet swapped
 * for another sheet mid-way would present nothing on iOS. Tapping an error
 * dismisses it; progress cannot be dismissed, the run is short.
 *
 * It sits at the top of the screen, under the status bar. The editor host
 * draws it over every tab and cannot tell whether a tab bar is showing: at
 * the bottom it lay in the tab bar's band, over the tabs, "+" and the
 * Search circle — an error until it was tapped away. Up here it also stays
 * clear of the notices a screen stacks above its bottom edge. VoiceOver
 * hears each step as it comes.
 */
export function CaptureBanner({
  onDismiss,
  state,
}: {
  onDismiss: () => void;
  state: CaptureState;
}) {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  const message =
    state.kind === 'idle' || state.kind === 'review'
      ? null
      : state.kind === 'reading'
        ? 'Reading the image…'
        : state.kind === 'extracting'
          ? 'Looking for events…'
          : state.message === CAPTURE_MODEL_UNAVAILABLE
            ? 'The on-device model is unavailable — Solunivo’s AI features need iOS 26 with Apple Intelligence.'
            : state.message;
  const error = state.kind === 'error';
  useEffect(() => {
    if (message !== null) {
      announce(error ? `${message} Tap to dismiss.` : message);
    }
  }, [error, message]);
  if (message === null) {
    return null;
  }
  return (
    <Pressable
      accessibilityRole={error ? 'button' : 'text'}
      disabled={!error}
      onPress={onDismiss}
      style={[styles.toast, { top: insets.top + NOTICE_GAP }, error ? styles.error : styles.info]}
      testID="capture-banner"
    >
      <Text style={[styles.text, error ? styles.onError : styles.onInfo]}>{message}</Text>
      {error ? <Text style={[styles.detail, styles.onError]}>Tap to dismiss</Text> : null}
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    detail: {
      fontSize: 11,
      marginTop: 2,
      textAlign: 'center',
    },
    error: {
      backgroundColor: colors.danger,
    },
    // Inverted against the canvas, like the other notices.
    info: {
      backgroundColor: colors.text,
    },
    onError: {
      color: colors['on-danger'],
    },
    onInfo: {
      color: colors.canvas,
    },
    text: {
      fontSize: 13,
      textAlign: 'center',
    },
    toast: {
      alignSelf: 'center',
      borderRadius: 10,
      elevation: 4,
      maxWidth: '90%',
      paddingHorizontal: 16,
      paddingVertical: 8,
      position: 'absolute',
      shadowColor: '#000000',
      shadowOffset: { height: 2, width: 0 },
      shadowOpacity: 0.25,
      shadowRadius: 6,
      zIndex: 40,
    },
  });
