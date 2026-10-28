import { BackendProvider, makeBackendAtoms } from '@calendar/app-state';
import { Stack } from 'expo-router';
import { setBackgroundColorAsync } from 'expo-system-ui';
import { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { backendClient } from '../src/backend.ts';
import { EditorHostProvider } from '../src/ui/EditorHost.tsx';
import { EDITOR_SHEET_DETENTS, editorDetentIndex } from '../src/ui/editorSheet.ts';
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
              {/* The editor: a form sheet at half height for a new item (the
                  calendar behind stays live and draws the drafts), full for
                  an existing one; `detent` comes with the push. A drag up
                  on the form raises a half sheet to full before the form
                  scrolls, as Maps' and Find My's sheets do, so the form
                  never scrolls on its own in the strip under the header.
                  Its forms are grouped cards, so the sheet takes the
                  grouped ground. */}
              <Stack.Screen
                name="editor"
                options={({ route }) => ({
                  contentStyle: { backgroundColor: groupedGround(colors) },
                  presentation: 'formSheet',
                  sheetAllowedDetents: [...EDITOR_SHEET_DETENTS],
                  sheetExpandsWhenScrolledToEdge: true,
                  sheetGrabberVisible: true,
                  sheetInitialDetentIndex: editorDetentIndex(
                    (route.params as { detent?: string } | undefined)?.detent,
                  ),
                  sheetLargestUndimmedDetentIndex: 0,
                })}
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
