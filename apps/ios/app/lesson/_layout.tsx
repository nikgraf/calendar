import { Stack } from 'expo-router';
import { StyleSheet } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { NotificationSettingsProvider } from '../../src/ui/settings/NotificationSettings.tsx';
import { SettingsProvider } from '../../src/ui/settings/SettingsContext.tsx';
import { groupedGround, useTheme } from '../../src/ui/theme.ts';
import { MutationNoticeToast, NOTICE_GAP, NoticeStack } from '../../src/ui/Toast.tsx';

/**
 * A Getting started lesson that is a page of its own: a modal over the
 * tabs (or over Settings, when opened from there) holding the Settings
 * sections it teaches, under the same providers Settings mounts — the
 * connection state and the notification editors. One page per lesson;
 * Done in its bar closes it.
 */
export default function LessonLayout() {
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <GestureHandlerRootView style={styles.root}>
      <SettingsProvider>
        <NotificationSettingsProvider>
          <Stack
            screenOptions={{
              contentStyle: { backgroundColor: groupedGround(colors) },
              headerLargeTitleShadowVisible: false,
              headerShadowVisible: false,
              headerTintColor: colors.primary,
              headerTitleStyle: { color: colors.text },
              headerTransparent: true,
            }}
          >
            <Stack.Screen name="alerts" />
            <Stack.Screen name="contacts" />
            <Stack.Screen name="zones" />
            <Stack.Screen name="other-device" />
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
