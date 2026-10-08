import { BackendProvider, makeBackendAtoms } from '@calendar/app-state';
import { Stack } from 'expo-router';
import { setBackgroundColorAsync } from 'expo-system-ui';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { backendClient } from '../src/backend.ts';
import { EditorHostProvider } from '../src/ui/EditorHost.tsx';
import { ErrorBoundary } from '../src/ui/ErrorBoundary.tsx';
import { useTheme } from '../src/ui/theme.ts';

const backendAtoms = makeBackendAtoms(backendClient);

/** The window behind every screen takes the canvas color, so a transition never flashes white (or black). */
function SystemBackground() {
  const { colors } = useTheme();
  useEffect(() => {
    void setBackgroundColorAsync(colors.canvas);
  }, [colors.canvas]);
  return null;
}

/**
 * The root of the router tree: the providers every screen needs, then a
 * native stack whose first screen is the tab bar. Sync, invalidations
 * and the share pickup still start inside the calendar screen.
 */
export default function RootLayout() {
  return (
    <GestureHandlerRootView style={styles.root}>
      <ErrorBoundary>
        <BackendProvider atoms={backendAtoms}>
          <SystemBackground />
          <EditorHostProvider>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
            </Stack>
          </EditorHostProvider>
        </BackendProvider>
      </ErrorBoundary>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
