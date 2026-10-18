import { choiceLabel, choiceQuestion, isAtSlot, type useThreadEditor } from '@calendar/app-state';
import { formatSlotLabel, placeCandidateLabel } from '@calendar/core';
import { SymbolView } from 'expo-symbols';
import { Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { ThreadTurnList } from './ThreadTurnList.tsx';
import { BOX_FONT_SCALE, type ThemeColors, useStyles, useTheme } from './theme.ts';

/**
 * The thread above a new item's form: the turns newest first, two
 * until "+N earlier queries" opens the rest (`ThreadTurnList`, Undo on
 * the newest), a caveat the drafts came with, the free slots a finder
 * phrase offered (the one the form sits in selected; a tap moves the
 * draft), the names the words invited that need a contact picked (a tap
 * on one makes it a guest, ✕ lets the name go), and with several drafts
 * the pager, Remove and "Add all". The same test ids as the desktop's
 * panel.
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
  const { colors } = useTheme();
  // The sheet's header does not scroll: the turns get at most a third of
  // the screen and scroll inside it, so the form under them stays in reach.
  const { height } = useWindowDimensions();
  const {
    addAll,
    batchError,
    canAddAll,
    dismissInvitee,
    drafts,
    focused,
    focusedDraft,
    inviteeChoices,
    keepPlace,
    liveItem,
    moveToSlot,
    pickInvitee,
    pickPlaceChoice,
    placeChoice,
    settled,
    switchFocus,
    thread,
    turns,
    write,
  } = editor;
  if (turns.length === 0) {
    return null;
  }
  const slots = focusedDraft?.slots;
  return (
    <View style={styles.section} testID="draft-thread">
      {/* Hung under the quick-add field, as part of it (its `attached`). */}
      <ThreadTurnList
        attached
        maxHeight={Math.round(height * 0.3)}
        onUndo={thread.undo}
        testIDPrefix="draft"
        turns={turns}
        undoDisabled={thread.busy || !settled}
      />
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
      {placeChoice ? (
        <View style={styles.choice} testID="draft-place-choices">
          <Text style={styles.note}>Which place for “{placeChoice.text}”?</Text>
          <ScrollView
            contentContainerStyle={styles.chips}
            horizontal
            keyboardShouldPersistTaps="handled"
            showsHorizontalScrollIndicator={false}
            style={styles.chipScroller}
          >
            {placeChoice.candidates.map((candidate, index) => (
              <Pressable
                accessibilityHint={candidate.geo.name ?? candidate.geo.source}
                accessibilityRole="button"
                accessibilityState={{ disabled: !settled }}
                disabled={!settled}
                key={`${candidate.source}:${candidate.geo.source}`}
                onPress={() => pickPlaceChoice(candidate)}
                style={styles.chip}
                testID={`draft-place-pick-${String(index)}`}
              >
                <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.chipLabel}>
                  {placeCandidateLabel(candidate)}
                </Text>
              </Pressable>
            ))}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !settled }}
              disabled={!settled}
              onPress={keepPlace}
              style={styles.keep}
              testID="draft-place-keep"
            >
              <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.secondary}>
                Keep “{placeChoice.text}”
              </Text>
            </Pressable>
          </ScrollView>
        </View>
      ) : null}
      {inviteeChoices.length > 0 ? (
        <View style={styles.choices} testID="draft-invitee-choices">
          {inviteeChoices.map((choice, index) => (
            <View
              key={choice.name}
              style={styles.choice}
              testID={`draft-invitee-choice-${String(index)}`}
            >
              <View style={styles.choiceHeader}>
                <Text style={[styles.note, styles.choiceQuestion]}>{choiceQuestion(choice)}</Text>
                <Pressable
                  accessibilityLabel={`Don’t invite ${choice.name}`}
                  accessibilityRole="button"
                  disabled={!settled}
                  hitSlop={8}
                  onPress={() => dismissInvitee(choice.name)}
                  style={!settled && styles.disabled}
                  testID={`draft-invitee-dismiss-${String(index)}`}
                >
                  <SymbolView
                    name="xmark"
                    size={12}
                    tintColor={colors['text-secondary']}
                    weight="semibold"
                  />
                </Pressable>
              </View>
              {choice.contacts.length > 0 ? (
                <ScrollView
                  contentContainerStyle={styles.chips}
                  horizontal
                  keyboardShouldPersistTaps="handled"
                  showsHorizontalScrollIndicator={false}
                  style={styles.chipScroller}
                >
                  {choice.contacts.map((contact, at) => (
                    <Pressable
                      accessibilityHint={contact.email}
                      accessibilityRole="button"
                      accessibilityState={{ disabled: !settled }}
                      disabled={!settled}
                      key={contact.email}
                      onPress={() => pickInvitee(choice.name, contact)}
                      style={styles.chip}
                      testID={`draft-invitee-pick-${String(index)}-${String(at)}`}
                    >
                      <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.chipLabel}>
                        {choiceLabel(contact, choice)}
                      </Text>
                    </Pressable>
                  ))}
                </ScrollView>
              ) : null}
            </View>
          ))}
        </View>
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
    // A card on the form's ground, like the field above it.
    chip: {
      backgroundColor: colors.surface,
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 7,
    },
    chipChosen: {
      backgroundColor: colors.selection,
    },
    chipLabel: {
      color: colors.text,
      fontSize: 15,
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
    choice: {
      gap: 4,
    },
    choiceHeader: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 8,
      justifyContent: 'space-between',
    },
    choiceQuestion: {
      flexShrink: 1,
    },
    choices: {
      gap: 8,
    },
    disabled: {
      opacity: 0.35,
    },
    error: {
      color: colors.danger,
      fontSize: 13,
    },
    keep: {
      justifyContent: 'center',
      paddingHorizontal: 6,
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
      gap: 8,
      paddingBottom: 12,
      paddingHorizontal: 16,
    },
  });
