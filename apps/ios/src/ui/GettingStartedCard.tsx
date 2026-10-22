import { useAccounts, useOnboarding, useUpdateOnboarding } from '@calendar/app-state';
import {
  cardVisible,
  type LessonId,
  type LessonRowId,
  lessonCopy,
  lessonProgress,
  lessonRows,
} from '@calendar/core';
import { MenuView } from '@expo/ui/community/menu';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useOnboardingEnabled } from '../onboarding.ts';
import { useEditorHost } from './EditorHost.tsx';
import { Glyph } from './GroupedList.tsx';
import { openLesson } from './lessons.ts';
import { BOX_FONT_SCALE, type ThemeColors, useStyles, useTheme } from './theme.ts';

/**
 * The Getting started card at the top of the Calendar tab: one row per
 * lesson, tried or skipped rows ticked, the progress in the header. A
 * row opens its lesson in place; "Add your accounts" leads the list
 * while nothing is connected and opens the setup. The chevron folds the
 * card to one line, the menu removes it; it leaves by itself once every
 * row is ticked, and never re-expands on its own — Settings › Getting
 * Started brings it back.
 */
export function GettingStartedCard({ timeZone }: { timeZone: string }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const host = useEditorHost();
  const enabled = useOnboardingEnabled();
  const state = useOnboarding();
  const update = useUpdateOnboarding();
  const accounts = useAccounts();
  if (!enabled || state === null || !cardVisible(state)) {
    return null;
  }
  const progress = lessonProgress(state);
  const rows = lessonRows(state, { accountCount: accounts.length });
  const open = (id: LessonRowId) => {
    if (id === 'accounts') {
      router.push('/setup/sources');
    } else {
      openLesson(id as LessonId, host, { from: 'calendar', timeZone });
    }
  };

  if (state.card === 'collapsed') {
    return (
      <Pressable
        accessibilityHint="Shows the lessons"
        accessibilityRole="button"
        onPress={() => void update({ card: 'expanded' })}
        style={({ pressed }) => [styles.bar, pressed && styles.pressed]}
        testID="getting-started"
      >
        <Text maxFontSizeMultiplier={BOX_FONT_SCALE} numberOfLines={1} style={styles.barLabel}>
          Getting started · {progress.done} of {progress.total}
        </Text>
        <Glyph
          name="chevron.right"
          size={13}
          tintColor={colors['text-secondary']}
          weight="semibold"
        />
      </Pressable>
    );
  }

  return (
    <View style={styles.card} testID="getting-started">
      <View style={styles.header}>
        <Text accessibilityRole="header" style={styles.title}>
          Getting started
        </Text>
        <Text style={styles.progress} testID="getting-started-progress">
          {progress.done} of {progress.total}
        </Text>
        <MenuView
          actions={[{ attributes: { destructive: true }, id: 'hide', title: 'Hide the card' }]}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === 'hide') {
              void update({ card: 'hidden' });
            }
          }}
          title="Settings › Getting Started lists the lessons and brings the card back."
        >
          <Pressable
            accessibilityLabel="More"
            accessibilityRole="button"
            hitSlop={8}
            style={styles.iconButton}
            testID="getting-started-more"
          >
            <Glyph name="ellipsis" size={16} tintColor={colors['text-secondary']} weight="medium" />
          </Pressable>
        </MenuView>
        <Pressable
          accessibilityLabel="Collapse"
          accessibilityRole="button"
          hitSlop={8}
          onPress={() => void update({ card: 'collapsed' })}
          style={styles.iconButton}
          testID="getting-started-collapse"
        >
          <Glyph
            name="chevron.down"
            size={14}
            tintColor={colors['text-secondary']}
            weight="semibold"
          />
        </Pressable>
      </View>
      <View
        accessibilityLabel={`${String(progress.done)} of ${String(progress.total)} done`}
        accessibilityRole="progressbar"
        style={styles.track}
      >
        <View style={[styles.fill, { width: `${(progress.done / progress.total) * 100}%` }]} />
      </View>
      {rows.map((row) => {
        const copy = lessonCopy(row.id, 'iphone');
        const ticked = row.mark !== undefined;
        return (
          <Pressable
            accessibilityLabel={`${copy.title}${ticked ? ', done' : ''}`}
            accessibilityRole="button"
            key={row.id}
            onPress={() => open(row.id)}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            testID={`getting-started-row-${row.id}`}
          >
            {ticked ? (
              <Glyph
                name="checkmark.circle.fill"
                size={20}
                tintColor={colors.primary}
                weight="medium"
              />
            ) : (
              <View style={styles.ring} />
            )}
            <View style={styles.rowText}>
              <Text numberOfLines={1} style={[styles.rowTitle, ticked && styles.rowTicked]}>
                {copy.title}
              </Text>
              {ticked ? null : (
                <Text numberOfLines={1} style={styles.rowSubtitle}>
                  {copy.subtitle}
                </Text>
              )}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    bar: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 12,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 8,
      marginBottom: 6,
      marginHorizontal: 16,
      paddingHorizontal: 14,
      paddingVertical: 9,
    },
    barLabel: {
      color: colors.text,
      flex: 1,
      fontSize: 14,
      fontWeight: '600',
    },
    card: {
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 16,
      borderWidth: StyleSheet.hairlineWidth,
      marginBottom: 6,
      marginHorizontal: 16,
      paddingBottom: 6,
      paddingHorizontal: 10,
      paddingTop: 10,
    },
    fill: {
      backgroundColor: colors.primary,
      borderRadius: 2,
      height: 4,
    },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: 4,
    },
    iconButton: {
      alignItems: 'center',
      height: 28,
      justifyContent: 'center',
      width: 28,
    },
    pressed: {
      opacity: 0.6,
    },
    progress: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    ring: {
      borderColor: colors['border-strong'],
      borderRadius: 10,
      borderWidth: 1.5,
      height: 20,
      width: 20,
    },
    row: {
      alignItems: 'center',
      borderRadius: 10,
      flexDirection: 'row',
      gap: 10,
      paddingHorizontal: 4,
      paddingVertical: 6,
    },
    rowSubtitle: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    rowText: {
      flex: 1,
    },
    rowTicked: {
      color: colors['text-secondary'],
      textDecorationLine: 'line-through',
    },
    rowTitle: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '500',
    },
    title: {
      color: colors.text,
      flex: 1,
      fontSize: 15,
      fontWeight: '600',
    },
    track: {
      backgroundColor: colors.fill,
      borderRadius: 2,
      height: 4,
      marginBottom: 4,
      marginHorizontal: 4,
      marginTop: 8,
      overflow: 'hidden',
    },
  });
