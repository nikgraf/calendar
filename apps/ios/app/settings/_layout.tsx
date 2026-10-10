import { Stack } from 'expo-router';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NotificationSettingsProvider } from '../../src/ui/settings/NotificationSettings.tsx';
import { SettingsProvider } from '../../src/ui/settings/SettingsContext.tsx';
import { groupedGround, useTheme } from '../../src/ui/theme.ts';
import { MutationNoticeToast, NOTICE_GAP, NoticeStack } from '../../src/ui/Toast.tsx';

/**
 * A page opened directly (the calendar's unsynced badge pushes
 * `/settings/unsynced` with `withAnchor`) lands on top of the root page.
 */
export const unstable_settings = { initialRouteName: 'index' };

/**
 * Settings: a modal over the tabs holding its own native stack — the root
 * list, then a page per pane (the Mac's panes, minus Agents) and the pages
 * under them. Done sits on the root only; a pushed page goes back, and the
 * sheet's swipe down closes Settings from anywhere. The providers hold the
 * connection state and the notification editors every page shares; the
 * toast covers every page, since the modal hides the tabs' own, and stands
 * over the home indicator.
 */
export default function SettingsLayout() {
  const { colors } = useTheme();
  const ground = groupedGround(colors);
  const insets = useSafeAreaInsets();
  return (
    <GestureHandlerRootView style={styles.root}>
      <SettingsProvider>
        <NotificationSettingsProvider>
          {/* A transparent header over the page's ground, iOS 26's own bar
              (a glass edge once content scrolls under it). A background
              color instead hid the root's large title, and left an opaque
              band of the system background above every pushed page. */}
          <Stack
            screenOptions={{
              contentStyle: { backgroundColor: ground },
              headerBackButtonDisplayMode: 'minimal',
              headerLargeTitleShadowVisible: false,
              headerLargeTitleStyle: { color: colors.text },
              headerShadowVisible: false,
              headerTintColor: colors.primary,
              headerTitleStyle: { color: colors.text },
              headerTransparent: true,
            }}
          >
            <Stack.Screen name="index" options={{ headerLargeTitle: true, title: 'Settings' }} />
            <Stack.Screen name="unsynced" options={{ title: 'Unsynced Changes' }} />
            <Stack.Screen name="account" options={{ title: '' }} />
            <Stack.Screen name="calendar" options={{ title: '' }} />
            <Stack.Screen name="device" options={{ title: 'On This iPhone' }} />
            <Stack.Screen name="general" options={{ title: 'General' }} />
            <Stack.Screen name="notifications" options={{ title: 'Notifications' }} />
            <Stack.Screen name="birthday-leads" options={{ title: 'Remind Me' }} />
            <Stack.Screen name="mirrors" options={{ title: '' }} />
            <Stack.Screen name="mirror" options={{ title: '' }} />
            <Stack.Screen name="file" options={{ title: 'Settings File' }} />
            <Stack.Screen name="advanced" options={{ title: 'Advanced' }} />
            <Stack.Screen name="diagnostics" options={{ title: 'Diagnostics' }} />
            <Stack.Screen name="pr-preview" options={{ title: 'PR Preview' }} />
          </Stack>
        </NotificationSettingsProvider>
        <NoticeStack offset={insets.bottom + NOTICE_GAP}>
          <MutationNoticeToast />
        </NoticeStack>
      </SettingsProvider>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
  },
});
