import { useAccounts, usePendingOps } from '@calendar/app-state';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Avatar, Glyph } from './settings/GroupedList.tsx';
import { avatarColors, initialOf } from './settings/SettingsRoot.tsx';
import { BOX_FONT_SCALE, type ThemeColors, useStyles, useTheme } from './theme.ts';

const SIZE = 30;

/**
 * The way into Settings, top right on the Calendar and Tasks tabs where
 * Apple's own apps (App Store, Music, Photos, Health) and Google's put
 * the account: the first Google account's photo — its initial in the
 * tint its Settings row has, without one — or a person symbol when no
 * Google account is connected. Unsynced changes are its badge, the count
 * as the App Store badges updates (the list is the Settings root's first
 * row), and a dot says an account must sign in again.
 */
export function AccountButton() {
  const router = useRouter();
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  const accounts = useAccounts();
  const pending = usePendingOps().length;
  const google = accounts.filter((account) => account.provider === 'google');
  const first = google[0];
  const signInNeeded = google.some((account) => account.status === 'reauth_required');
  const tint = avatarColors(colors, 0);
  const label = [
    'Settings',
    pending > 0 ? `${String(pending)} unsynced ${pending === 1 ? 'change' : 'changes'}` : null,
    signInNeeded ? 'an account needs you to sign in' : null,
  ]
    .filter((part) => part !== null)
    .join(', ');

  return (
    <View style={styles.wrap}>
      <Pressable
        accessibilityLabel={label}
        accessibilityLargeContentTitle="Settings"
        accessibilityRole="button"
        accessibilityShowsLargeContentViewer
        hitSlop={7}
        onPress={() => router.push('/settings')}
        style={({ pressed }) => pressed && styles.pressed}
        testID="open-settings"
      >
        {first ? (
          <Avatar
            background={tint.background}
            foreground={tint.foreground}
            label={initialOf(first)}
            size={SIZE}
            uri={first.avatarUrl}
          />
        ) : (
          <Glyph name="person.crop.circle" size={SIZE} tintColor={colors['text-secondary']} />
        )}
      </Pressable>
      {/* Siblings of the button, not children: the button is one
          accessibility element, so a child's id would never reach Maestro
          (the live suite waits on `pending-badge` to go). VoiceOver hears
          the count in the button's label instead. */}
      {pending > 0 ? (
        <View pointerEvents="none" style={styles.badge} testID="pending-badge">
          <Text accessible={false} maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.badgeLabel}>
            {pending > 99 ? '99+' : pending}
          </Text>
        </View>
      ) : signInNeeded ? (
        <View pointerEvents="none" style={styles.dot} testID="sign-in-dot" />
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // Ringed in the canvas so it reads apart from the photo under it.
    badge: {
      alignItems: 'center',
      backgroundColor: colors.warning,
      borderColor: colors.canvas,
      borderRadius: 10,
      borderWidth: 2,
      justifyContent: 'center',
      minHeight: 20,
      minWidth: 20,
      paddingHorizontal: 4,
      position: 'absolute',
      right: -8,
      top: -6,
    },
    badgeLabel: {
      color: colors['on-warning'],
      fontSize: 11,
      fontWeight: '700',
    },
    dot: {
      backgroundColor: colors.warning,
      borderColor: colors.canvas,
      borderRadius: 7,
      borderWidth: 2,
      height: 14,
      position: 'absolute',
      right: -3,
      top: -3,
      width: 14,
    },
    pressed: {
      opacity: 0.6,
    },
    wrap: {
      marginLeft: 8,
    },
  });
