import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Glyph } from '../GroupedList.tsx';
import { type ThemeColors, useStyles, useTheme } from '../theme.ts';
import { useSetup } from './SetupContext.tsx';

/**
 * The first screen of a fresh install: what Solunivo is in two lines,
 * and two doors — set up from scratch, or copy a setup from the Mac (a
 * settings file for now; a code later). Skip goes straight to the
 * calendar, where the Getting started card picks the setup up again.
 */
export function SetupWelcome() {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { finish } = useSetup();
  return (
    <View
      style={[
        styles.screen,
        { paddingBottom: Math.max(insets.bottom, 24), paddingTop: insets.top + 8 },
      ]}
      testID="setup-welcome"
    >
      <View style={styles.bar}>
        <Pressable
          accessibilityRole="button"
          hitSlop={10}
          onPress={() => finish('skipped')}
          style={({ pressed }) => pressed && styles.pressed}
          testID="setup-skip"
        >
          <Text style={styles.skip}>Skip</Text>
        </Pressable>
      </View>
      <View style={styles.hero}>
        <View style={styles.mark}>
          <Glyph name="calendar" size={32} tintColor={colors['on-primary']} weight="medium" />
        </View>
        <Text accessibilityRole="header" style={styles.title}>
          Welcome to Solunivo
        </Text>
        <Text style={styles.lead}>
          Your Google calendars, Apple Calendar and Reminders, side by side. Everything stays on
          this iPhone — there is no Solunivo server.
        </Text>
      </View>
      <View style={styles.doors}>
        <Door
          onPress={() => router.push('/setup/sources')}
          primary
          subtitle="Pick what you use, connect it, done in a minute"
          symbol="calendar.badge.plus"
          testID="setup-start"
          title="Set up"
        />
        <Door
          onPress={() => router.push('/setup/copy')}
          subtitle="Already using Solunivo there? Bring its settings over and skip the setup"
          symbol="doc.badge.arrow.up"
          testID="setup-copy"
          title="Copy from your Mac"
        />
      </View>
      <Text style={styles.footnote}>
        Skip takes you straight to the calendar. Everything here can be done later from Getting
        started.
      </Text>
    </View>
  );
}

function Door({
  onPress,
  primary = false,
  subtitle,
  symbol,
  testID,
  title,
}: {
  onPress: () => void;
  primary?: boolean;
  subtitle: string;
  symbol: 'calendar.badge.plus' | 'doc.badge.arrow.up';
  testID: string;
  title: string;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityLabel={`${title}. ${subtitle}`}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.door,
        primary ? styles.doorPrimary : styles.doorQuiet,
        pressed && styles.pressed,
      ]}
      testID={testID}
    >
      <Glyph
        name={symbol}
        size={26}
        tintColor={primary ? colors['on-primary'] : colors.text}
        weight="regular"
      />
      <View style={styles.doorText}>
        <Text style={[styles.doorTitle, primary ? styles.onPrimary : styles.onQuiet]}>{title}</Text>
        <Text style={[styles.doorSubtitle, primary ? styles.onPrimaryMuted : styles.onQuietMuted]}>
          {subtitle}
        </Text>
      </View>
      <Glyph
        name="chevron.right"
        size={14}
        tintColor={primary ? colors['on-primary'] : colors['text-secondary']}
        weight="semibold"
      />
    </Pressable>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    bar: {
      alignItems: 'center',
      flexDirection: 'row',
      height: 32,
      justifyContent: 'flex-end',
    },
    door: {
      alignItems: 'center',
      borderRadius: 16,
      flexDirection: 'row',
      gap: 14,
      paddingHorizontal: 16,
      paddingVertical: 18,
    },
    doorPrimary: {
      backgroundColor: colors.primary,
    },
    // On the welcome's canvas ground: the fill, so the card reads as one.
    doorQuiet: {
      backgroundColor: colors.fill,
    },
    doors: {
      gap: 12,
      marginTop: 44,
    },
    doorSubtitle: {
      fontSize: 14,
      lineHeight: 19,
    },
    doorText: {
      flex: 1,
      gap: 2,
    },
    doorTitle: {
      fontSize: 17,
      fontWeight: '600',
    },
    footnote: {
      color: colors['text-secondary'],
      fontSize: 13,
      lineHeight: 18,
      marginTop: 'auto',
      textAlign: 'center',
    },
    hero: {
      gap: 10,
      marginTop: 48,
    },
    lead: {
      color: colors['text-secondary'],
      fontSize: 17,
      lineHeight: 24,
    },
    mark: {
      alignItems: 'center',
      backgroundColor: colors.primary,
      borderRadius: 18,
      height: 64,
      justifyContent: 'center',
      marginBottom: 14,
      width: 64,
    },
    onPrimary: {
      color: colors['on-primary'],
    },
    onPrimaryMuted: {
      color: colors['on-primary'],
      opacity: 0.8,
    },
    onQuiet: {
      color: colors.text,
    },
    onQuietMuted: {
      color: colors['text-secondary'],
    },
    pressed: {
      opacity: 0.7,
    },
    screen: {
      backgroundColor: colors.canvas,
      flex: 1,
      paddingHorizontal: 24,
    },
    skip: {
      color: colors['text-secondary'],
      fontSize: 17,
    },
    title: {
      color: colors.text,
      fontSize: 32,
      fontWeight: '700',
      letterSpacing: -0.4,
      lineHeight: 38,
    },
  });
