import {
  choiceQuestion,
  isAtSlot,
  isGuestQuestion,
  isPlaceQuestion,
  pickedCandidate,
  readsAsSaid,
  SCOPE_OPTIONS,
  type useThreadEditor,
} from '@calendar/app-state';
import { formatSlotLabel, placeCandidateLabel } from '@calendar/core';
import { SymbolView } from 'expo-symbols';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SegmentedControl } from '../SegmentedControl.tsx';
import { BOX_FONT_SCALE, type ThemeColors, useStyles, useTheme } from '../theme.ts';
import { QuestionCard } from './QuestionCard.tsx';

/**
 * What the assistant asks under its newest card, left out while there is
 * nothing to ask: a caveat the drafts came with, for a saved series what
 * a change applies to, the free slots a finder phrase offered (the one
 * the form sits in selected; a tap moves the draft), then its questions
 * one at a time (`QuestionCard`: which place a text means, which contact
 * a name). Not asked, a row each: a lone place that was taken (the text
 * as said a tap away), a name no contact has (✕ lets it go). An answer
 * is a step: going back over it asks again. The same test ids as the
 * desktop's panel.
 */
export function DraftQuestions({
  editor,
  note,
}: {
  readonly editor: ReturnType<typeof useThreadEditor>;
  /** A caveat about the drafts (the shared text was cut short). */
  readonly note?: string | undefined;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const {
    assistant,
    dismissInvitee,
    dismissPlace,
    drafts,
    eventModel,
    focusedDraft,
    inviteeChoices,
    keepPlace,
    kinds,
    liveItem,
    moveToSlot,
    pickPlaceChoice,
    placeChoice,
    placeGeo,
    settled,
  } = editor;
  const threadNote = note && drafts.length > 0 ? note : undefined;
  const slots =
    focusedDraft?.slots && focusedDraft.slots.length > 1 && liveItem.kind === 'event'
      ? focusedDraft.slots
      : undefined;
  // A saved series: a phrase changes it at the scope the form is at.
  const scoped = assistant === 'saved' && kinds.mode === 'event' && eventModel.isRecurring;
  // A lone place taken, and names nobody has: told, not asked.
  const lonePlace = placeChoice && !isPlaceQuestion(placeChoice) ? placeChoice : undefined;
  const notes = inviteeChoices.filter((choice) => !isGuestQuestion(choice));
  if (!(threadNote || slots || scoped || editor.questions.current || lonePlace || notes.length)) {
    return null;
  }
  return (
    <View style={styles.section} testID="draft-thread">
      {threadNote ? (
        <Text style={styles.note} testID="draft-thread-note">
          {threadNote}
        </Text>
      ) : null}
      {scoped ? (
        <View style={styles.choice} testID="draft-scope">
          <Text style={styles.note}>Apply to</Text>
          <SegmentedControl
            accessibilityLabel="Apply changes to"
            ground
            grow
            onChange={eventModel.setScope}
            options={SCOPE_OPTIONS.map((option) => ({
              disabled: !settled,
              label: option.short,
              testID: `draft-scope-${option.value}`,
              value: option.value,
            }))}
            value={eventModel.scope}
          />
        </View>
      ) : null}
      {slots ? (
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
      <QuestionCard editor={editor} />
      {lonePlace ? (
        <View style={styles.choice} testID="draft-place-choices">
          <View style={styles.choiceHeader}>
            <Text style={[styles.note, styles.choiceQuestion]}>Place for “{lonePlace.text}”</Text>
            <Pressable
              accessibilityLabel="Hide the places"
              accessibilityRole="button"
              disabled={!settled}
              hitSlop={8}
              onPress={dismissPlace}
              style={!settled && styles.disabled}
              testID="draft-place-dismiss"
            >
              <SymbolView
                name="xmark"
                size={12}
                tintColor={colors['text-secondary']}
                weight="semibold"
              />
            </Pressable>
          </View>
          {/* Wrapped, not scrolled: a place's label is its name and address,
              wider than the sheet at times — in a horizontal row one such
              label wrapped and stretched every pill to two lines, and the
              first filled the row with the rest out of sight. */}
          <View style={styles.placeChips}>
            {lonePlace.candidates.map((candidate, index) => {
              const chosen =
                pickedCandidate(lonePlace, eventModel.location, placeGeo) === candidate;
              return (
                <Pressable
                  accessibilityHint={candidate.geo.name ?? candidate.geo.source}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: !settled, selected: chosen }}
                  disabled={!settled}
                  key={`${candidate.source}:${candidate.geo.source}`}
                  onPress={() => pickPlaceChoice(candidate)}
                  style={[styles.chip, styles.placeChip, chosen && styles.chipChosen]}
                  testID={`draft-place-pick-${String(index)}`}
                >
                  <Text
                    maxFontSizeMultiplier={BOX_FONT_SCALE}
                    style={[styles.chipLabel, chosen && styles.chipLabelChosen]}
                  >
                    {placeCandidateLabel(candidate)}
                  </Text>
                </Pressable>
              );
            })}
            <Pressable
              accessibilityRole="button"
              accessibilityState={{
                disabled: !settled,
                selected: readsAsSaid(lonePlace, eventModel.location, placeGeo),
              }}
              disabled={!settled}
              onPress={keepPlace}
              style={styles.keep}
              testID="draft-place-keep"
            >
              <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.secondary}>
                As said: “{lonePlace.text}”
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
      {notes.length > 0 ? (
        <View style={styles.choices} testID="draft-invitee-choices">
          {notes.map((choice) => {
            const index = String(inviteeChoices.indexOf(choice));
            return (
              <View
                key={choice.name}
                style={[styles.choice, styles.choiceHeader]}
                testID={`draft-invitee-choice-${index}`}
              >
                <Text style={[styles.note, styles.choiceQuestion]}>{choiceQuestion(choice)}</Text>
                <Pressable
                  accessibilityLabel={`Don’t invite ${choice.name}`}
                  accessibilityRole="button"
                  disabled={!settled}
                  hitSlop={8}
                  onPress={() => dismissInvitee(choice.name)}
                  style={!settled && styles.disabled}
                  testID={`draft-invitee-dismiss-${index}`}
                >
                  <SymbolView
                    name="xmark"
                    size={12}
                    tintColor={colors['text-secondary']}
                    weight="semibold"
                  />
                </Pressable>
              </View>
            );
          })}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // A card on the form's ground, like the field above it.
    chip: {
      backgroundColor: colors.surface,
      borderRadius: 999,
      paddingHorizontal: 12,
      paddingVertical: 7,
    },
    chipChosen: {
      backgroundColor: colors.primary,
    },
    chipLabel: {
      color: colors.text,
      fontSize: 15,
    },
    chipLabelChosen: {
      color: colors['on-primary'],
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
    keep: {
      justifyContent: 'center',
      paddingHorizontal: 6,
      paddingVertical: 7,
    },
    note: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    // A pill no wider than the row: a label past it wraps inside its own pill.
    placeChip: {
      flexShrink: 1,
    },
    placeChips: {
      alignItems: 'flex-start',
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
    },
    secondary: {
      color: colors['text-secondary'],
      fontSize: 15,
    },
    // In the conversation, which has the insets.
    section: {
      gap: 8,
    },
  });
