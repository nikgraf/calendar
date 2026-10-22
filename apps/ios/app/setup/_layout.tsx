import { Stack } from 'expo-router';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SettingsProvider } from '../../src/ui/settings/SettingsContext.tsx';
import { SetupProvider } from '../../src/ui/setup/SetupContext.tsx';
import { groupedGround, useTheme } from '../../src/ui/theme.ts';

/** A step opened directly lands over the welcome, so Back always leads somewhere. */
export const unstable_settings = { initialRouteName: 'index' };

/**
 * The first run: a full-screen modal over the tabs holding its own stack
 * of steps — the welcome, "What do you use?", one screen per ticked
 * source, and the copy door with its screen after. The pages draw their
 * own bar (the step dots, Skip), so the stack shows no header. The
 * connection state is the one Settings uses (`SettingsProvider`: the
 * permission statuses, Google sign-in, the device connects), mounted
 * here as well so the steps share it.
 */
export default function SetupLayout() {
  const { colors } = useTheme();
  return (
    <GestureHandlerRootView style={styles.root}>
      <SettingsProvider>
        <SetupProvider>
          <Stack
            screenOptions={{
              contentStyle: { backgroundColor: groupedGround(colors) },
              headerShown: false,
            }}
          >
            <Stack.Screen
              name="index"
              options={{ contentStyle: { backgroundColor: colors.canvas } }}
            />
            <Stack.Screen name="sources" />
            <Stack.Screen name="google" />
            <Stack.Screen name="apple-calendar" />
            <Stack.Screen name="reminders" />
            <Stack.Screen name="copy" />
            <Stack.Screen name="copied" />
          </Stack>
        </SetupProvider>
      </SettingsProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
