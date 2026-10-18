import { earlierTurnsLabel, TURNS_SHOWN, visibleTurns } from '@calendar/app-state';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeInUp,
  ReduceMotion,
  useReducedMotion,
} from 'react-native-reanimated';
import { BOX_FONT_SCALE, type ThemeColors, useStyles, useTheme } from './theme.ts';

/** A turn arriving: it settles into the top row from just above it. */
const ENTER = FadeInUp.duration(220)
  .easing(Easing.out(Easing.cubic))
  .withInitialValues({ opacity: 0, transform: [{ translateY: -6 }] });
/** With Reduce Motion: a fade, no movement (Reanimated would otherwise skip it). */
const ENTER_STILL = FadeIn.duration(200).reduceMotion(ReduceMotion.Never);

/**
 * A thread's turns as one card, newest first, as on the desktop: what was
 * said and what it changed, wrapped in full, the newest with Undo, a
 * hairline between rows. Two show until the last row, "+N earlier
 * queries ⌄" (the tint color and a disclosure chevron, the way "Show
 * More" reads in Apple's own apps), opens the rest. `attached`: the card
 * hangs under the field the words were typed into (the edit sheet's),
 * square on top with a hairline between — an extension of the field;
 * Search's field is the system's, so its card stands on its own. A row
 * eases in when it comes into the list (Reanimated's `entering` runs on
 * mount only, so an Undo or the list opening never replays the top
 * row's). In a header that does not scroll (the edit sheet's),
 * `maxHeight` caps the rows and they scroll inside it; the last row stays
 * in reach. The create thread (`draft-*`) and the search thread
 * (`search-*`) share it.
 */
export function ThreadTurnList({
  attached = false,
  maxHeight,
  onUndo,
  testIDPrefix,
  turns,
  undoDisabled,
}: {
  attached?: boolean | undefined;
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
  const { colors } = useTheme();
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
      style={[styles.turn, index > 0 && styles.separated]}
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
    <View style={[styles.card, attached && styles.cardAttached]}>
      {/* Its own view: a top-only border on a rounded view bevels its corners. */}
      {attached ? <View style={styles.rule} /> : null}
      {maxHeight === undefined ? (
        rows
      ) : (
        <ScrollView keyboardShouldPersistTaps="handled" style={{ flexGrow: 0, maxHeight }}>
          {rows}
        </ScrollView>
      )}
      {turns.length > TURNS_SHOWN ? (
        // The card's last row; one control both ways, so VoiceOver stays on it.
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={() => setExpanded(!expanded)}
          style={({ pressed }) => [styles.more, styles.separated, pressed && styles.pressed]}
          testID={`${testIDPrefix}-turns-${expanded ? 'less' : 'more'}`}
        >
          <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.moreLabel}>
            {expanded ? 'Show less' : earlierTurnsLabel(hidden)}
          </Text>
          <SymbolView
            name={expanded ? 'chevron.up' : 'chevron.down'}
            size={11}
            tintColor={colors.primary}
            weight="semibold"
          />
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
    card: {
      backgroundColor: colors.fill,
      borderRadius: 10,
      overflow: 'hidden',
    },
    // Under the field: square on top, a hairline (`rule`) between it and
    // the rows, and the field's own surface (the editor's ground is the
    // fill color).
    cardAttached: {
      backgroundColor: colors.surface,
      borderBottomLeftRadius: 14,
      borderBottomRightRadius: 14,
      borderTopLeftRadius: 0,
      borderTopRightRadius: 0,
    },
    disabled: {
      opacity: 0.35,
    },
    more: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 4,
      paddingHorizontal: 12,
      paddingVertical: 9,
    },
    moreLabel: {
      color: colors.primary,
      fontSize: 13,
      fontWeight: '600',
    },
    pressed: {
      backgroundColor: colors.border,
    },
    rule: {
      backgroundColor: colors['border-strong'],
      height: StyleSheet.hairlineWidth,
    },
    // A hairline in the strong border color: the plain one is all but the fill.
    separated: {
      borderColor: colors['border-strong'],
      borderTopWidth: StyleSheet.hairlineWidth,
    },
    summary: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    turn: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
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
