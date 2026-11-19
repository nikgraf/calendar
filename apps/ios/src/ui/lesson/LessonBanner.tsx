import { LESSON_COUNT, type LessonId, lessonCopy, lessonPosition } from '@calendar/core';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Glyph } from '../GroupedList.tsx';
import { type ThemeColors, useStyles, useTheme } from '../theme.ts';

/** What the banner says to do, per lesson that runs inside an existing surface. */
const HINTS: Partial<Record<LessonId, string>> = {
  create: 'Send it, or say your own — the answer is the event as a card. Save keeps it.',
  search: 'The sentence became the chips: remove one, or say more — “only tasks”, “in Vienna”.',
};

/**
 * The lesson's frame when the lesson is an existing surface: a line
 * above the editor's conversation or the search chips saying which
 * lesson this is and what to try, with Skip until it was tried. The
 * surface itself is the real thing; nothing else changes.
 */
export function LessonBanner({
  action,
  id,
  note,
  onSkip,
  progress,
}: {
  /** What the note asks for (the Create lesson's download of the Assistant's model). */
  action?: { readonly label: string; readonly onPress: () => void } | undefined;
  id: LessonId;
  /** In place of the hint: the Create lesson without the Assistant's model, and the demo standing in. */
  note?: string | undefined;
  /** Absent once the lesson was tried: the hint stays, Skip has nothing left to skip. */
  onSkip?: (() => void) | undefined;
  /** How far the model's download is, in percent, while it runs. */
  progress?: number | undefined;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const copy = lessonCopy(id, 'iphone');
  return (
    <View style={styles.banner} testID="lesson-banner">
      <Glyph name="sparkles" size={16} tintColor={colors.primary} weight="medium" />
      <View style={styles.text}>
        <Text style={styles.title}>
          Getting started · {lessonPosition(id)} of {LESSON_COUNT} — {copy.title}
        </Text>
        <Text style={styles.hint} testID="lesson-banner-note">
          {note ?? HINTS[id] ?? copy.intro}
        </Text>
        {progress === undefined ? null : (
          <View
            accessibilityLabel={`${String(progress)} percent downloaded`}
            accessibilityRole="progressbar"
            style={styles.track}
            testID="lesson-model-progress"
          >
            <View style={[styles.fill, { width: `${String(progress)}%` }]} />
          </View>
        )}
        {action === undefined ? null : (
          <Pressable
            accessibilityRole="button"
            onPress={action.onPress}
            style={({ pressed }) => [styles.action, pressed && styles.pressed]}
            testID="lesson-model-action"
          >
            <Text style={styles.actionLabel}>{action.label}</Text>
          </Pressable>
        )}
      </View>
      {onSkip ? (
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={onSkip}
          style={({ pressed }) => pressed && styles.pressed}
          testID="lesson-skip"
        >
          <Text style={styles.skip}>Skip</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    /** The download, in the ink of an action, under the note. */
    action: {
      alignItems: 'center',
      alignSelf: 'flex-start',
      backgroundColor: colors.primary,
      borderRadius: 22,
      justifyContent: 'center',
      marginTop: 8,
      minHeight: 44,
      paddingHorizontal: 18,
    },
    actionLabel: {
      color: colors['on-primary'],
      fontSize: 15,
      fontWeight: '600',
    },
    banner: {
      alignItems: 'flex-start',
      backgroundColor: colors.surface,
      borderRadius: 14,
      flexDirection: 'row',
      gap: 10,
      marginBottom: 10,
      marginHorizontal: 16,
      paddingHorizontal: 14,
      paddingVertical: 10,
    },
    fill: {
      backgroundColor: colors.primary,
      borderRadius: 2,
      height: 4,
    },
    hint: {
      color: colors['text-secondary'],
      fontSize: 13,
      lineHeight: 18,
      marginTop: 2,
    },
    pressed: {
      opacity: 0.6,
    },
    skip: {
      color: colors['text-secondary'],
      fontSize: 15,
    },
    text: {
      flex: 1,
    },
    title: {
      color: colors.text,
      fontSize: 13,
      fontWeight: '600',
    },
    track: {
      backgroundColor: colors.fill,
      borderRadius: 2,
      height: 4,
      marginTop: 8,
      overflow: 'hidden',
    },
  });
