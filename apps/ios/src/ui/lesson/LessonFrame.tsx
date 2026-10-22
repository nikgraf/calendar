import { LessonTriedContext, useMarkLesson } from '@calendar/app-state';
import { LESSON_COUNT, type LessonId, lessonCopy, lessonPosition } from '@calendar/core';
import { Stack, useRouter } from 'expo-router';
import { type ReactNode, useEffect, useEffectEvent, useRef } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { SettingsPage } from '../GroupedList.tsx';
import { type ThemeColors, useStyles, useTheme } from '../theme.ts';

/** The lessons the modal frames: the Settings sections, tried in place. */
export type FramedLessonId = Exclude<LessonId, 'create' | 'search'>;

/**
 * A lesson as a page of its own: "Getting started · n of 6" and the
 * title in the bar, one paragraph, then the Settings sections it teaches
 * — Notifications, the Contacts ask, Time Zones, the export — as they
 * are in Settings. The first thing tried ticks the lesson as done;
 * leaving without trying (Done, a swipe down) ticks it as skipped.
 */
export function LessonFrame({ children, id }: { children: ReactNode; id: FramedLessonId }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const router = useRouter();
  const copy = lessonCopy(id, 'iphone');
  const markLesson = useMarkLesson();
  const tried = useRef(false);
  const onTried = () => {
    if (!tried.current) {
      tried.current = true;
      void markLesson(id, 'done');
    }
  };
  // Done, or a swipe down, without a try: skipped.
  const leave = useEffectEvent(() => {
    if (!tried.current) {
      void markLesson(id, 'skipped');
    }
  });
  useEffect(() => () => leave(), []);
  return (
    <>
      <Stack.Screen options={{ title: copy.title }} />
      <SettingsPage testID={`lesson-${id}`}>
        <View style={styles.intro}>
          <Text style={styles.step}>
            Getting started · {lessonPosition(id)} of {LESSON_COUNT}
          </Text>
          <Text style={styles.introText}>{copy.intro}</Text>
        </View>
        <LessonTriedContext value={onTried}>{children}</LessonTriedContext>
      </SettingsPage>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Button
          accessibilityLabel="Done"
          icon="checkmark"
          onPress={() => router.back()}
          tintColor={colors.primary}
          variant="done"
        />
      </Stack.Toolbar>
    </>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    intro: {
      gap: 6,
      paddingHorizontal: 32,
      paddingTop: 8,
    },
    introText: {
      color: colors.text,
      fontSize: 15,
      lineHeight: 21,
    },
    step: {
      color: colors['text-secondary'],
      fontSize: 13,
      fontWeight: '600',
      textTransform: 'uppercase',
    },
  });
