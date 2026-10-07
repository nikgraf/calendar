import { useRouter } from 'expo-router';
import { SettingsScreen } from '../src/ui/SettingsScreen.tsx';

/** Settings as a modal over the tabs; Done (and the swipe down) closes it. */
export default function SettingsRoute() {
  const router = useRouter();
  return <SettingsScreen onClose={() => router.back()} />;
}
