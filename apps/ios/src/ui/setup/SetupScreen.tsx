import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { groupedGround, type ThemeColors, useStyles } from '../theme.ts';

/**
 * One screen of the first run: step dots and Skip along the top, a
 * title and a lead paragraph, the page's own content scrolling under
 * them, and the actions pinned to the bottom. Drawn on the grouped
 * ground, like Settings, so the pages' cards sit on it.
 */
export function SetupScreen({
  actions,
  children,
  lead,
  onSkip,
  step,
  testID,
  title,
}: {
  /** Pinned to the bottom: the primary button, and a quieter one under it. */
  actions?: ReactNode;
  children?: ReactNode;
  lead?: string;
  /** Skip, top right: leaves the setup for the calendar. */
  onSkip?: (() => void) | undefined;
  /** The dots: this screen's place among the steps the ticks lead through. */
  step?: { readonly index: number; readonly total: number } | undefined;
  testID: string;
  title: string;
}) {
  const styles = useStyles(makeStyles);
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.screen, { paddingTop: insets.top + 8 }]} testID={testID}>
      <View style={styles.bar}>
        {step ? (
          <View
            accessibilityLabel={`Step ${String(step.index + 1)} of ${String(step.total)}`}
            accessible
            style={styles.dots}
          >
            {Array.from({ length: step.total }, (_, index) => (
              <View key={index} style={[styles.dot, index === step.index && styles.dotCurrent]} />
            ))}
          </View>
        ) : (
          <View />
        )}
        {onSkip ? (
          <Pressable
            accessibilityRole="button"
            hitSlop={10}
            onPress={onSkip}
            style={({ pressed }) => pressed && styles.pressed}
            testID="setup-skip"
          >
            <Text style={styles.skip}>Skip</Text>
          </Pressable>
        ) : null}
      </View>
      <ScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
        style={styles.scroll}
      >
        <Text accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        {lead ? <Text style={styles.lead}>{lead}</Text> : null}
        {children}
      </ScrollView>
      {actions ? (
        <View style={[styles.actions, { paddingBottom: Math.max(insets.bottom, 16) }]}>
          {actions}
        </View>
      ) : null}
    </View>
  );
}

/** The setup's buttons: one filled, the rest quiet, full width. */
export function SetupButton({
  disabled = false,
  label,
  onPress,
  testID,
  variant = 'primary',
}: {
  disabled?: boolean;
  label: string;
  onPress: () => void;
  testID: string;
  variant?: 'primary' | 'quiet';
}) {
  const styles = useStyles(makeStyles);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        variant === 'primary' ? styles.buttonPrimary : styles.buttonQuiet,
        pressed && styles.pressed,
        disabled && styles.disabled,
      ]}
      testID={testID}
    >
      <Text style={variant === 'primary' ? styles.buttonPrimaryLabel : styles.buttonQuietLabel}>
        {label}
      </Text>
    </Pressable>
  );
}

/** One line of what a source brings: a small mark, then the words. */
export function SetupPoint({ children }: { children: string }) {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.point}>
      <View style={styles.pointMark} />
      <Text style={styles.pointText}>{children}</Text>
    </View>
  );
}

/** A note under a page's content: what the system will ask, where to change it later. */
export function SetupNote({ children, testID }: { children: string; testID?: string }) {
  const styles = useStyles(makeStyles);
  return (
    <Text style={styles.note} testID={testID}>
      {children}
    </Text>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    actions: {
      gap: 10,
      paddingHorizontal: 24,
      paddingTop: 12,
    },
    bar: {
      alignItems: 'center',
      flexDirection: 'row',
      height: 32,
      justifyContent: 'space-between',
      paddingHorizontal: 24,
    },
    button: {
      alignItems: 'center',
      borderRadius: 14,
      justifyContent: 'center',
      minHeight: 52,
      paddingHorizontal: 16,
    },
    buttonPrimary: {
      backgroundColor: colors.primary,
    },
    buttonPrimaryLabel: {
      color: colors['on-primary'],
      fontSize: 17,
      fontWeight: '600',
    },
    buttonQuiet: {
      backgroundColor: colors.surface,
    },
    buttonQuietLabel: {
      color: colors.text,
      fontSize: 17,
      fontWeight: '600',
    },
    content: {
      gap: 16,
      paddingBottom: 24,
      paddingHorizontal: 24,
      paddingTop: 28,
    },
    disabled: {
      opacity: 0.4,
    },
    dot: {
      backgroundColor: colors['border-strong'],
      borderRadius: 3,
      height: 6,
      width: 6,
    },
    dotCurrent: {
      backgroundColor: colors.primary,
      width: 24,
    },
    dots: {
      flexDirection: 'row',
      gap: 6,
    },
    lead: {
      color: colors['text-secondary'],
      fontSize: 15,
      lineHeight: 21,
      marginTop: -6,
    },
    note: {
      color: colors['text-secondary'],
      fontSize: 13,
      lineHeight: 18,
    },
    point: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      gap: 10,
    },
    pointMark: {
      backgroundColor: colors.primary,
      borderRadius: 3,
      height: 6,
      marginTop: 7,
      width: 6,
    },
    pointText: {
      color: colors.text,
      flex: 1,
      fontSize: 15,
      lineHeight: 20,
    },
    pressed: {
      opacity: 0.6,
    },
    screen: {
      backgroundColor: groupedGround(colors),
      flex: 1,
    },
    scroll: {
      flex: 1,
    },
    skip: {
      color: colors['text-secondary'],
      fontSize: 17,
    },
    title: {
      color: colors.text,
      fontSize: 28,
      fontWeight: '700',
      letterSpacing: -0.3,
      lineHeight: 34,
    },
  });
