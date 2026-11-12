import {
  choiceLabel,
  choiceQuestion,
  isAtSlot,
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

/**
 * What the assistant asks under its newest card, left out while there is
 * nothing to ask: a caveat the drafts came with, for a saved series what
 * a change applies to, the free slots a finder phrase offered (the one
 * the form sits in selected; a tap moves the draft), the places a text
 * could mean, and the names the words invited that need a contact picked
 * (a tap on one makes it a guest, ✕ lets the name go). An answer is a
 * step: going back over it asks again. The same test ids as the
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
    pickInvitee,
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
  if (!(threadNote || slots || scoped || inviteeChoices.length > 0 || placeChoice)) {
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
      {placeChoice ? (
        <View style={styles.choice} testID="draft-place-choices">
          <View style={styles.choiceHeader}>
            <Text style={[styles.note, styles.choiceQuestion]}>Place for “{placeChoice.text}”</Text>
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
            {placeChoice.candidates.map((candidate, index) => {
              const chosen =
                pickedCandidate(placeChoice, eventModel.location, placeGeo) === candidate;
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
                selected: readsAsSaid(placeChoice, eventModel.location, placeGeo),
              }}
              disabled={!settled}
              onPress={keepPlace}
              style={styles.keep}
              testID="draft-place-keep"
            >
              <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.secondary}>
                As said: “{placeChoice.text}”
              </Text>
            </Pressable>
          </View>
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
