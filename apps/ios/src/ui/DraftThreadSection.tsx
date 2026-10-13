import { isAtSlot, type useThreadEditor } from '@calendar/app-state';
import { formatSlotLabel } from '@calendar/core';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { BOX_FONT_SCALE, type ThemeColors, useStyles } from './theme.ts';

/**
 * The thread above a new item's form: the last turn on one line — what
 * was said, what it changed, Undo (the sheet's header does not scroll,
 * and Undo takes back only the last turn) — a caveat the drafts came
 * with, the free slots a finder phrase offered (the one the form sits in
 * selected; a tap moves the draft), and with several drafts the pager,
 * Remove and "Add all". The same test ids as the desktop's panel.
 */
export function DraftThreadSection({
  editor,
  note,
}: {
  editor: ReturnType<typeof useThreadEditor>;
  /** A caveat about the drafts (the shared text was cut short). */
  note?: string | undefined;
}) {
  const styles = useStyles(makeStyles);
  const {
    addAll,
    batchError,
    canAddAll,
    drafts,
    focused,
    focusedDraft,
    liveItem,
    moveToSlot,
    settled,
    switchFocus,
    thread,
    turns,
    write,
  } = editor;
  const last = turns.at(-1);
  if (last === undefined) {
    return null;
  }
  const slots = focusedDraft?.slots;
  return (
    <View style={styles.section} testID="draft-thread">
      <View style={styles.turn} testID="draft-turn">
        <Text numberOfLines={1} style={styles.utterance}>
          “{last.utterance}”
        </Text>
        <Text numberOfLines={1} style={styles.summary} testID="draft-turn-summary">
          {last.summary}
        </Text>
        <Pressable
          accessibilityRole="button"
          disabled={thread.busy || !settled}
          hitSlop={8}
          onPress={thread.undo}
          testID="draft-undo"
        >
          <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.action}>
            Undo
          </Text>
        </Pressable>
      </View>
      {note && drafts.length > 0 ? (
        <Text style={styles.note} testID="draft-thread-note">
          {note}
        </Text>
      ) : null}
      {slots && slots.length > 1 && liveItem.kind === 'event' ? (
        <ScrollView
          contentContainerStyle={styles.chips}
          horizontal
          keyboardShouldPersistTaps="handled"
          showsHorizontalScrollIndicator={false}
          style={styles.chipScroller}
          testID="draft-slots"
        >
          {slots.map((slot, index) => {
            const chosen = isAtSlot(liveItem, slot);
            return (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: !settled, selected: chosen }}
                disabled={!settled}
                key={`${slot.date}T${slot.startTime}`}
                onPress={() => moveToSlot(slot)}
                style={[styles.chip, chosen && styles.chipChosen]}
                testID={`draft-slot-${String(index)}`}
              >
                <Text
                  maxFontSizeMultiplier={BOX_FONT_SCALE}
                  style={[styles.chipLabel, chosen && styles.chipLabelChosen]}
                >
                  {formatSlotLabel(slot)}
                </Text>
              </Pressable>
            );
          })}
        </ScrollView>
      ) : null}
      {drafts.length > 1 ? (
        <View style={styles.pager} testID="draft-pager">
          <View style={styles.pagerSide}>
            <Pressable
              accessibilityLabel="Previous draft"
              accessibilityRole="button"
              disabled={focused === 0 || !settled}
              hitSlop={8}
              onPress={() => switchFocus(focused - 1)}
              style={(focused === 0 || !settled) && styles.disabled}
              testID="draft-prev"
            >
              <Text style={styles.arrow}>‹</Text>
            </Pressable>
            <Text style={styles.position} testID="draft-position">
              {focused + 1} of {drafts.length}
            </Text>
            <Pressable
              accessibilityLabel="Next draft"
              accessibilityRole="button"
              disabled={focused >= drafts.length - 1 || !settled}
              hitSlop={8}
              onPress={() => switchFocus(focused + 1)}
              style={(focused >= drafts.length - 1 || !settled) && styles.disabled}
              testID="draft-next"
            >
              <Text style={styles.arrow}>›</Text>
            </Pressable>
          </View>
          <View style={styles.pagerSide}>
            <Pressable
              accessibilityRole="button"
              disabled={!settled}
              hitSlop={8}
              onPress={() => thread.remove(focused)}
              testID="draft-remove"
            >
              <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.secondary}>
                Remove
              </Text>
            </Pressable>
            {canAddAll ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ busy: write.busy, disabled: !settled }}
                disabled={!settled}
                onPress={() => void addAll()}
                style={[styles.addAll, !settled && styles.disabled]}
                testID="draft-add-all"
              >
                <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.addAllLabel}>
                  Add all {drafts.length}
                </Text>
              </Pressable>
            ) : null}
          </View>
        </View>
      ) : null}
      {batchError ? (
        <Text selectable style={styles.error} testID="draft-batch-error">
          {batchError}
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    action: {
      color: colors.primary,
      fontSize: 15,
      fontWeight: '600',
    },
    addAll: {
      backgroundColor: colors.primary,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 4,
    },
    addAllLabel: {
      color: colors['on-primary'],
      fontSize: 14,
      fontWeight: '600',
    },
    arrow: {
      color: colors.primary,
      fontSize: 22,
      lineHeight: 24,
      paddingHorizontal: 6,
    },
    chip: {
      backgroundColor: colors.fill,
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    chipChosen: {
      backgroundColor: colors.selection,
    },
    chipLabel: {
      color: colors.text,
      fontSize: 14,
    },
    chipLabelChosen: {
      color: colors['on-selection'],
      fontWeight: '600',
    },
    // A horizontal ScrollView in a column stretches unless told not to.
    chips: {
      gap: 6,
    },
    chipScroller: {
      flexGrow: 0,
      flexShrink: 0,
    },
    disabled: {
      opacity: 0.35,
    },
    error: {
      color: colors.danger,
      fontSize: 13,
    },
    note: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    pager: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    pagerSide: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 10,
    },
    position: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    secondary: {
      color: colors['text-secondary'],
      fontSize: 15,
    },
    section: {
      gap: 6,
      paddingBottom: 2,
      paddingHorizontal: 16,
    },
    // What changed takes the room; what was said gives way first.
    summary: {
      color: colors.text,
      flex: 1,
      fontSize: 13,
    },
    turn: {
      alignItems: 'center',
      backgroundColor: colors.fill,
      borderRadius: 8,
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: 10,
      paddingVertical: 7,
    },
    utterance: {
      color: colors['text-secondary'],
      flexShrink: 1,
      fontSize: 13,
      maxWidth: '45%',
    },
  });
