import type { DraftOccurrence } from '@calendar/app-state';
import { formatClockTime, type FreeSlot } from '@calendar/core';
import { type DimensionValue, Pressable, StyleSheet, Text, View } from 'react-native';
import { BOX_FONT_SCALE, type ThemeColors, useEventTint, useStyles } from './theme.ts';

/**
 * A draft from the editor's thread on the timeline: dashed, a lighter
 * fill of its calendar's tint, tagged "DRAFT" — not an event yet. React
 * Native has no repeating gradient, so the desktop's hatch is a dashed
 * edge here; the tag says the rest. The focused draft carries a ring. A
 * candidate — a free slot offered beside the focused draft — is fainter
 * and dotted, tagged "OPTION"; a tap moves the draft there. A tap on a
 * draft focuses it in the editor.
 */
export function DraftBlock({
  compact,
  height,
  left,
  occurrence,
  onPress,
  timeZone,
  top,
  width,
}: {
  compact: boolean;
  height: number;
  left: DimensionValue;
  occurrence: DraftOccurrence;
  onPress: (draftId: string, slot?: FreeSlot) => void;
  timeZone: string;
  top: number;
  width: DimensionValue;
}) {
  const styles = useStyles(makeStyles);
  const tint = useEventTint(occurrence.color);
  const { candidate } = occurrence;
  const times = `${formatClockTime(occurrence.startUtc, timeZone)} – ${formatClockTime(occurrence.endUtc, timeZone)}`;
  return (
    <View
      pointerEvents="box-none"
      style={[styles.frame, occurrence.focused && styles.focused, { height, left, top, width }]}
    >
      <Pressable
        accessibilityLabel={
          candidate ? `Free slot, ${times}` : `Draft: ${occurrence.title || 'Untitled'}, ${times}`
        }
        accessibilityRole="button"
        onPress={() => onPress(occurrence.draftId, candidate)}
        style={[
          styles.block,
          candidate ? styles.candidate : styles.draft,
          { backgroundColor: tint.fill, borderColor: tint.edge },
        ]}
        testID={candidate ? 'slot-candidate' : 'draft-block'}
      >
        <View style={styles.titleRow}>
          <Text
            maxFontSizeMultiplier={BOX_FONT_SCALE}
            numberOfLines={1}
            style={[styles.title, compact && styles.titleCompact, { color: tint.text }]}
          >
            {occurrence.title || 'Untitled'}
          </Text>
          {compact ? null : (
            <Text
              maxFontSizeMultiplier={BOX_FONT_SCALE}
              style={[styles.tag, { borderColor: tint.text, color: tint.text }]}
            >
              {candidate ? 'OPTION' : 'DRAFT'}
            </Text>
          )}
        </View>
        {compact || height < 34 ? null : (
          <Text
            maxFontSizeMultiplier={BOX_FONT_SCALE}
            numberOfLines={1}
            style={[styles.time, { color: tint.text }]}
          >
            {times}
          </Text>
        )}
      </Pressable>
    </View>
  );
}

/** An all-day draft in the lane: the same dashed edge, one row high, ringed when focused. */
export function DraftChip({
  height,
  occurrence,
  onPress,
}: {
  height: number;
  occurrence: DraftOccurrence;
  onPress: (draftId: string) => void;
}) {
  const styles = useStyles(makeStyles);
  const tint = useEventTint(occurrence.color);
  return (
    <View style={[styles.chipFrame, occurrence.focused && styles.chipFocused, { height }]}>
      <Pressable
        accessibilityLabel={`Draft: ${occurrence.title || 'Untitled'}, all day`}
        accessibilityRole="button"
        hitSlop={4}
        onPress={() => onPress(occurrence.draftId)}
        style={[styles.chip, styles.draft, { backgroundColor: tint.fill, borderColor: tint.edge }]}
        testID="draft-chip"
      >
        <Text
          maxFontSizeMultiplier={BOX_FONT_SCALE}
          numberOfLines={1}
          style={[styles.chipText, { color: tint.text }]}
        >
          {occurrence.title || 'Untitled'}
        </Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    block: {
      borderRadius: 6,
      borderWidth: 1,
      flex: 1,
      overflow: 'hidden',
      paddingHorizontal: 6,
      paddingVertical: 2,
    },
    candidate: {
      borderStyle: 'dotted',
      opacity: 0.55,
    },
    chip: {
      borderRadius: 5,
      borderWidth: 1,
      flex: 1,
      justifyContent: 'center',
      paddingHorizontal: 6,
    },
    chipFocused: {
      borderColor: colors.primary,
      borderWidth: 2,
      padding: 1,
    },
    chipFrame: {
      borderRadius: 7,
    },
    chipText: {
      fontSize: 12,
      fontWeight: '500',
    },
    draft: {
      borderStyle: 'dashed',
      opacity: 0.85,
    },
    focused: {
      borderColor: colors.primary,
      borderRadius: 8,
      borderWidth: 2,
      padding: 1,
    },
    frame: {
      position: 'absolute',
      zIndex: 2,
    },
    tag: {
      borderRadius: 3,
      borderWidth: StyleSheet.hairlineWidth,
      fontSize: 8,
      fontWeight: '700',
      opacity: 0.8,
      paddingHorizontal: 3,
    },
    time: {
      fontSize: 11,
      opacity: 0.85,
    },
    title: {
      flexShrink: 1,
      fontSize: 13,
      fontWeight: '600',
    },
    titleCompact: {
      fontSize: 11,
      lineHeight: 13,
    },
    titleRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 4,
    },
  });
