import { BackendProvider, makeBackendAtoms } from '@calendar/app-state';
import { Stack } from 'expo-router';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { backendClient } from '../src/backend.ts';
import { ErrorBoundary } from '../src/ui/ErrorBoundary.tsx';

const backendAtoms = makeBackendAtoms(backendClient);

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
          <Stack screenOptions={{ headerShown: false }}>
            <Stack.Screen name="(tabs)" />
          </Stack>
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
