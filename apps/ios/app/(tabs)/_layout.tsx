import { NativeTabs } from 'expo-router/unstable-native-tabs';

/**
 * The native tab bar: Calendar, Tasks and Search. Search has the search
 * role, so iOS 26 draws it as its own circle and puts the search field of
 * its stack (`search/_layout.tsx`) in the bar. Settings is not a tab — it
 * opens as a modal stack from the account button at the top right of
 * Calendar and Tasks.
 */
export default function TabsLayout() {
  return (
    <NativeTabs>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Icon sf="calendar" />
        <NativeTabs.Trigger.Label>Calendar</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="tasks">
        <NativeTabs.Trigger.Icon sf="checklist" />
        <NativeTabs.Trigger.Label>Tasks</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="search" role="search">
        <NativeTabs.Trigger.Icon sf="magnifyingglass" />
        <NativeTabs.Trigger.Label>Search</NativeTabs.Trigger.Label>
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
