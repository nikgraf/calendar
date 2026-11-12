import { BackendProvider, makeBackendAtoms } from '@calendar/app-state';
import { Stack } from 'expo-router';
import { setBackgroundColorAsync } from 'expo-system-ui';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { backendClient } from '../src/backend.ts';
import { EditorHostProvider } from '../src/ui/EditorHost.tsx';
import { ErrorBoundary } from '../src/ui/ErrorBoundary.tsx';
import { groupedGround, useTheme } from '../src/ui/theme.ts';

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
  const { colors } = useTheme();
  return (
    <GestureHandlerRootView style={styles.root}>
      <ErrorBoundary>
        <BackendProvider atoms={backendAtoms}>
          <SystemBackground />
          <EditorHostProvider>
            <Stack screenOptions={{ headerShown: false }}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="settings" options={{ presentation: 'modal' }} />
              {/* The first run: full screen over the tabs, its steps a stack of its own. */}
              <Stack.Screen name="setup" options={{ presentation: 'fullScreenModal' }} />
              {/* A Getting started lesson that is a page of its own (Alerts, Contacts…). */}
              <Stack.Screen name="lesson" options={{ presentation: 'modal' }} />
              {/* The editor: a page sheet at full height, for a new item as
                  for an existing one, like Settings — not a form sheet,
                  which lays out a header and one scroll view and nothing
                  else, so it could hold neither a bar at its bottom nor
                  two views. Its forms are grouped cards, so the sheet
                  takes the grouped ground. */}
              <Stack.Screen
                name="editor"
                options={{
                  contentStyle: { backgroundColor: groupedGround(colors) },
                  presentation: 'modal',
                }}
              />
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
