import { CAPTURE_MODEL_UNAVAILABLE, type CaptureState } from '@calendar/app-state';
import { Pressable, StyleSheet, Text } from 'react-native';
import { type ThemeColors, useStyles } from './theme.ts';

/**
 * Progress and errors of a capture, as a banner rather than a sheet: a
 * single extracted event opens the editor directly, and a sheet swapped
 * for another sheet mid-way would present nothing on iOS. Tapping an error
 * dismisses it; progress cannot be dismissed, the run is short.
 */
export function CaptureBanner({
  onDismiss,
  state,
}: {
  onDismiss: () => void;
  state: CaptureState;
}) {
  const styles = useStyles(makeStyles);
  if (state.kind === 'idle' || state.kind === 'review') {
    return null;
  }
  const message =
    state.kind === 'reading'
      ? 'Reading the image…'
      : state.kind === 'extracting'
        ? 'Looking for events…'
        : state.message === CAPTURE_MODEL_UNAVAILABLE
          ? 'The on-device model is unavailable — Solunivo’s AI features need iOS 26 with Apple Intelligence.'
          : state.message;
  return (
    <Pressable
      accessibilityRole={state.kind === 'error' ? 'button' : 'text'}
      disabled={state.kind !== 'error'}
      onPress={onDismiss}
      style={[styles.toast, state.kind === 'error' ? styles.error : styles.info]}
      testID="capture-banner"
    >
      <Text style={styles.text}>{message}</Text>
      {state.kind === 'error' ? <Text style={styles.detail}>Tap to dismiss</Text> : null}
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    detail: {
      color: colors['on-primary'],
      fontSize: 11,
      marginTop: 2,
      textAlign: 'center',
    },
    error: {
      backgroundColor: colors.danger,
    },
    info: {
      backgroundColor: colors.text,
    },
    text: {
      color: colors['on-primary'],
      fontSize: 13,
      textAlign: 'center',
    },
    toast: {
      alignSelf: 'center',
      borderRadius: 10,
      bottom: 24,
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
