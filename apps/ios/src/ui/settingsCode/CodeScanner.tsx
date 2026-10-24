import { extractSettingsCode } from '@calendar/core/settingsCode';
import { useIsFocused } from 'expo-router';
import { useState } from 'react';
import { Linking, StyleSheet, Text, View } from 'react-native';
import { CapsuleButton } from '../GroupedList.tsx';
import { type ThemeColors, useStyles } from '../theme.ts';

/**
 * Lazily, inside a try: an OTA preview may run on a binary built before
 * expo-camera was in it (see useSettingsTransfer's `load`).
 */
const loadCamera = () => {
  try {
    // eslint-disable-next-line typescript/no-require-imports -- deliberate: see above
    return require('expo-camera') as typeof import('expo-camera');
  } catch {
    return undefined;
  }
};

type CameraModule = NonNullable<ReturnType<typeof loadCamera>>;

/**
 * - idle: the button; nothing asked yet.
 * - denied: iOS said no; Settings › Solunivo changes it.
 * - missing: a binary without the camera module, or no camera here.
 */
type ScannerState =
  | { readonly kind: 'denied' | 'idle' | 'missing' }
  | { readonly camera: CameraModule; readonly kind: 'live' };

/**
 * The camera as a settings-code reader, started by a tap — never on its
 * own, so no permission alert comes up unasked (or in a test). Only while
 * the screen is in front: a page pushed over it (the copied step) stops
 * it. `onCode` hears every settings code the camera sees; the reader
 * ignores repeats and reads while busy, and answers true for a read that
 * ran. Once one has (imported, declined or failed), the camera stops and
 * the button is back: the same code again is a fresh scan.
 */
export function CodeScanner({
  label = 'Scan the Code',
  onCode,
  onStart,
}: {
  label?: string;
  onCode: (code: string) => Promise<boolean>;
  /** A fresh scan: the reader may read a code it declined before. */
  onStart?: () => void;
}) {
  const styles = useStyles(makeStyles);
  const focused = useIsFocused();
  const [state, setState] = useState<ScannerState>({ kind: 'idle' });

  const start = async () => {
    onStart?.();
    const camera = loadCamera();
    if (!camera) {
      setState({ kind: 'missing' });
      return;
    }
    const permission = await camera.Camera.requestCameraPermissionsAsync();
    setState(permission.granted ? { camera, kind: 'live' } : { kind: 'denied' });
  };

  if (state.kind === 'live' && focused) {
    const { CameraView } = state.camera;
    return (
      <View style={styles.frame} testID="code-camera">
        <CameraView
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          facing="back"
          onBarcodeScanned={({ data }) => {
            const code = extractSettingsCode(data);
            if (code) {
              void onCode(code).then((ran) => {
                if (ran) {
                  setState((current) => (current.kind === 'live' ? { kind: 'idle' } : current));
                }
              });
            }
          }}
          onMountError={() => setState({ kind: 'missing' })}
          style={StyleSheet.absoluteFill}
        />
        <Text style={styles.hint}>Point the camera at the code on the Mac.</Text>
      </View>
    );
  }
  return (
    <View style={styles.idle}>
      <CapsuleButton label={label} onPress={() => void start()} testID="code-scan" />
      {state.kind === 'denied' ? (
        <Text style={styles.note} testID="code-camera-note">
          Camera access is off — allow it in Settings › Solunivo, or paste the code.{' '}
          <Text onPress={() => void Linking.openSettings()} style={styles.link}>
            Open Settings
          </Text>
        </Text>
      ) : state.kind === 'missing' ? (
        <Text style={styles.note} testID="code-camera-note">
          No camera here — paste the code instead.
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    frame: {
      aspectRatio: 1,
      backgroundColor: colors.fill,
      borderRadius: 16,
      justifyContent: 'flex-end',
      overflow: 'hidden',
      width: '100%',
    },
    hint: {
      backgroundColor: colors['surface-raised'],
      color: colors['text-secondary'],
      fontSize: 13,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    idle: {
      alignItems: 'flex-start',
      gap: 8,
    },
    link: {
      color: colors.primary,
      fontWeight: '600',
    },
    note: {
      color: colors['text-secondary'],
      fontSize: 13,
      lineHeight: 18,
    },
  });
