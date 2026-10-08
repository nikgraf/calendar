import { useEffect, useState } from 'react';
import { AppState, Linking, Text } from 'react-native';
import { type NotificationPermission, notificationPermission } from '../notifications.ts';
import { useSectionStyles } from './settingsShared.ts';

/**
 * iOS's notification permission, read without asking on mount and
 * whenever the app comes back (the user may have just changed it in the
 * Settings app); `recheck` reads it again after a save that asked.
 */
export const useNotificationPermission = (): [NotificationPermission | null, () => void] => {
  const [permission, setPermission] = useState<NotificationPermission | null>(null);
  const [reads, setReads] = useState(0);
  useEffect(() => {
    let mounted = true;
    const read = () => {
      void notificationPermission().then((next) => {
        if (mounted) {
          setPermission(next);
        }
      });
    };
    read();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') {
        read();
      }
    });
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, [reads]);
  return [permission, () => setReads((count) => count + 1)];
};

/**
 * Says notifications cannot arrive and links to where that is fixed —
 * shown as soon as the section knows, not only after a switch was flipped.
 */
export function NotificationsDenied({ testID }: { testID: string }) {
  const sectionStyles = useSectionStyles();
  return (
    <Text
      accessibilityRole="link"
      onPress={() => void Linking.openSettings()}
      style={sectionStyles.action}
      testID={testID}
    >
      Notifications are off for Solunivo in iOS Settings. Open Settings
    </Text>
  );
}
