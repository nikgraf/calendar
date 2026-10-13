import { earlierTurnsLabel, TURNS_SHOWN, visibleTurns } from '@calendar/app-state';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeInUp,
  ReduceMotion,
  useReducedMotion,
} from 'react-native-reanimated';
import { BOX_FONT_SCALE, type ThemeColors, useStyles } from './theme.ts';

/** A turn arriving: it settles into the top row from just above it. */
const ENTER = FadeInUp.duration(220)
  .easing(Easing.out(Easing.cubic))
  .withInitialValues({ opacity: 0, transform: [{ translateY: -6 }] });
/** With Reduce Motion: a fade, no movement (Reanimated would otherwise skip it). */
const ENTER_STILL = FadeIn.duration(200).reduceMotion(ReduceMotion.Never);

/**
 * A thread's turns, newest first, as on the desktop: what was said and
 * what it changed, wrapped in full, the newest with Undo. Three show
 * until "+N earlier queries" opens the rest. A row eases in when it comes
 * into the list (Reanimated's `entering` runs on mount only, so an Undo
 * or the list opening never replays the top row's). The create thread
 * (`draft-*`) and the search thread (`search-*`) share it. In a header
 * that does not scroll (the edit sheet's), `maxHeight` caps the rows and
 * they scroll inside it; "Show less" stays under them, in reach.
 */
export function ThreadTurnList({
  maxHeight,
  onUndo,
  testIDPrefix,
  turns,
  undoDisabled,
}: {
  maxHeight?: number | undefined;
  onUndo: () => void;
  testIDPrefix: string;
  turns: ReadonlyArray<{
    readonly id: string;
    readonly summary: string;
    readonly utterance: string;
  }>;
  undoDisabled: boolean;
}) {
  const styles = useStyles(makeStyles);
  const reduceMotion = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const { hidden, shown } = visibleTurns(turns, expanded);
  if (shown.length === 0) {
    return null;
  }
  const rows = shown.map((turn, index) => (
    <Animated.View
      entering={reduceMotion ? ENTER_STILL : ENTER}
      key={turn.id}
      style={styles.turn}
      testID={`${testIDPrefix}-turn`}
    >
      <View style={styles.body}>
        <Text style={styles.utterance}>“{turn.utterance}”</Text>
        <Text style={styles.summary} testID={`${testIDPrefix}-turn-summary`}>
          {turn.summary}
        </Text>
      </View>
      {index === 0 ? (
        <Pressable
          accessibilityRole="button"
          disabled={undoDisabled}
          hitSlop={8}
          onPress={onUndo}
          testID={`${testIDPrefix}-undo`}
        >
          <Text
            maxFontSizeMultiplier={BOX_FONT_SCALE}
            style={[styles.undo, undoDisabled && styles.disabled]}
          >
            Undo
          </Text>
        </Pressable>
      ) : null}
    </Animated.View>
  ));
  return (
    <View style={styles.list}>
      {maxHeight === undefined ? (
        rows
      ) : (
        <ScrollView
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          style={{ flexGrow: 0, maxHeight }}
        >
          {rows}
        </ScrollView>
      )}
      {turns.length > TURNS_SHOWN ? (
        // One control both ways, so VoiceOver stays on it.
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          hitSlop={6}
          onPress={() => setExpanded(!expanded)}
          style={styles.more}
          testID={`${testIDPrefix}-turns-${expanded ? 'less' : 'more'}`}
        >
          <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.moreLabel}>
            {expanded ? 'Show less' : earlierTurnsLabel(hidden)}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    body: {
      flex: 1,
      gap: 1,
    },
    disabled: {
      opacity: 0.35,
    },
    list: {
      gap: 4,
    },
    more: {
      alignSelf: 'flex-start',
      paddingHorizontal: 4,
      paddingVertical: 2,
    },
    moreLabel: {
      color: colors['text-secondary'],
      fontSize: 13,
      fontWeight: '500',
    },
    summary: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    turn: {
      alignItems: 'center',
      backgroundColor: colors.fill,
      borderRadius: 8,
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    undo: {
      color: colors.primary,
      fontSize: 15,
      fontWeight: '600',
    },
    utterance: {
      color: colors.text,
      fontSize: 13,
    },
  });
