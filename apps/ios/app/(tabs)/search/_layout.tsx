import { Stack } from 'expo-router';
import { useTheme } from '../../../src/ui/theme.ts';

/**
 * The Search tab is a native stack of one screen: the stack's header is
 * what holds the system search field (`Stack.SearchBar`), which iOS 26
 * moves into the tab bar for a tab with the search role.
 */
export default function SearchLayout() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={{
        contentStyle: { backgroundColor: colors.canvas },
        headerLargeTitleShadowVisible: false,
        headerLargeTitleStyle: { color: colors.text },
        headerShadowVisible: false,
        headerTintColor: colors.primary,
        headerTitleStyle: { color: colors.text },
        headerTransparent: true,
      }}
    >
      <Stack.Screen name="index" options={{ headerLargeTitle: true, title: 'Search' }} />
    </Stack>
  );
}
