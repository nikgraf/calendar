import { LESSON_COUNT, type LessonId, lessonCopy, lessonPosition } from '@calendar/core';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Glyph } from '../GroupedList.tsx';
import { type ThemeColors, useStyles, useTheme } from '../theme.ts';

/** What the banner says to do, per lesson that runs inside an existing surface. */
const HINTS: Partial<Record<LessonId, string>> = {
  create: 'Type or say it, then Apply — the draft lands on the calendar, dashed until you save.',
  search: 'The sentence became the chips: remove one, or say more — “only tasks”, “in Vienna”.',
};

/**
 * The lesson's frame when the lesson is an existing surface: a line
 * above the editor's quick-add field or the search chips saying which
 * lesson this is and what to try, with Skip. The surface itself is the
 * real thing; nothing else changes.
 */
export function LessonBanner({
  id,
  note,
  onSkip,
}: {
  id: LessonId;
  /** In place of the hint: why the lesson cannot run as drawn (the model is not ready). */
  note?: string | undefined;
  onSkip: () => void;
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
        <Text style={styles.hint}>{note ?? HINTS[id] ?? copy.intro}</Text>
      </View>
      <Pressable
        accessibilityRole="button"
        hitSlop={8}
        onPress={onSkip}
        style={({ pressed }) => pressed && styles.pressed}
        testID="lesson-skip"
      >
        <Text style={styles.skip}>Skip</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
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
  });
