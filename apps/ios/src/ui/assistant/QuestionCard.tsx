import {
  asSaidOption,
  contactOption,
  type OptionLabel,
  pickedCandidate,
  placeOption,
  questionCount,
  questionText,
  readsAsSaid,
  type useThreadEditor,
} from '@calendar/app-state';
import { SymbolView } from 'expo-symbols';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BOX_FONT_SCALE, type ThemeColors, useStyles, useTheme } from '../theme.ts';

/**
 * One answer, a full-width row: what it is over what tells it apart,
 * and "Taken" on the one the draft holds now.
 */
function Option({
  disabled,
  label,
  onPress,
  selected,
  testID,
}: {
  readonly disabled: boolean;
  readonly label: OptionLabel;
  readonly onPress: () => void;
  readonly selected: boolean;
  readonly testID: string;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityHint={label.detail || undefined}
      accessibilityLabel={label.title}
      accessibilityRole="button"
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [styles.option, pressed && styles.pressed, disabled && styles.off]}
      testID={testID}
    >
      <View style={styles.optionText}>
        <Text maxFontSizeMultiplier={BOX_FONT_SCALE} numberOfLines={2} style={styles.title}>
          {label.title}
        </Text>
        {label.detail ? (
          <Text maxFontSizeMultiplier={BOX_FONT_SCALE} numberOfLines={1} style={styles.detail}>
            {label.detail}
          </Text>
        ) : null}
      </View>
      {selected ? (
        <View style={styles.taken}>
          <SymbolView name="checkmark" size={13} tintColor={colors.text} weight="semibold" />
          <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.takenLabel}>
            Taken
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/**
 * What the Assistant asks, one question at a time under its newest card
 * (`questionsAsked`): its number among those its turn brought, the
 * question, the answers as rows and Skip. An answer is a step (going back
 * over it asks again); Skip leaves the form as it is. The desktop's
 * card, with the same test ids.
 */
export function QuestionCard({ editor }: { readonly editor: ReturnType<typeof useThreadEditor> }) {
  const styles = useStyles(makeStyles);
  const {
    eventModel,
    inviteeChoices,
    keepPlace,
    pickInvitee,
    pickPlaceChoice,
    placeGeo,
    questions,
    settled,
    skipQuestion,
  } = editor;
  const question = questions.current;
  if (question === undefined) {
    return null;
  }
  const disabled = !settled;
  const place = question.kind === 'place' ? question.choice : undefined;
  const guest = question.kind === 'guest' ? question.choice : undefined;
  // The ids count the draft's names, as the rows of choices did.
  const index = guest === undefined ? -1 : inviteeChoices.indexOf(guest);
  const held = place ? pickedCandidate(place, eventModel.location, placeGeo) : undefined;
  return (
    <View style={styles.card} testID="draft-question">
      <View style={styles.header}>
        <Text
          maxFontSizeMultiplier={BOX_FONT_SCALE}
          style={styles.count}
          testID="draft-question-count"
        >
          {questionCount(questions).toUpperCase()}
        </Text>
        <Pressable
          accessibilityLabel="Skip this question"
          accessibilityRole="button"
          disabled={disabled}
          hitSlop={8}
          onPress={skipQuestion}
          style={[styles.skip, disabled && styles.off]}
          testID="draft-question-skip"
        >
          <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.skipLabel}>
            Skip
          </Text>
        </Pressable>
      </View>
      <View
        style={styles.body}
        testID={place ? 'draft-place-choices' : `draft-invitee-choice-${String(index)}`}
      >
        <Text accessibilityRole="header" style={styles.question}>
          {questionText(question)}
        </Text>
        {place ? (
          <>
            {place.candidates.map((candidate, at) => (
              <Option
                disabled={disabled}
                key={`${candidate.source}:${candidate.geo.source}:${String(at)}`}
                label={placeOption(candidate)}
                onPress={() => pickPlaceChoice(candidate)}
                selected={held === candidate}
                testID={`draft-place-pick-${String(at)}`}
              />
            ))}
            <Option
              disabled={disabled}
              label={asSaidOption(place)}
              onPress={keepPlace}
              selected={readsAsSaid(place, eventModel.location, placeGeo)}
              testID="draft-place-keep"
            />
          </>
        ) : null}
        {guest
          ? guest.contacts.map((contact, at) => (
              <Option
                disabled={disabled}
                key={contact.email}
                label={contactOption(contact)}
                onPress={() => pickInvitee(guest.name, contact)}
                selected={false}
                testID={`draft-invitee-pick-${String(index)}-${String(at)}`}
              />
            ))
          : null}
      </View>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    body: {
      gap: 6,
    },
    /** A step quieter than the item's card above it: the ground's own tone. */
    card: {
      backgroundColor: colors['surface-subtle'],
      borderRadius: 20,
      gap: 2,
      paddingBottom: 10,
      paddingHorizontal: 10,
      paddingTop: 2,
    },
    count: {
      color: colors['text-secondary'],
      fontSize: 12,
      fontWeight: '600',
      letterSpacing: 0.3,
    },
    detail: {
      color: colors['text-secondary'],
      fontSize: 13,
      lineHeight: 17,
    },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingLeft: 6,
    },
    off: {
      opacity: 0.35,
    },
    option: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderColor: colors.border,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      flexDirection: 'row',
      gap: 12,
      justifyContent: 'space-between',
      minHeight: 52,
      paddingHorizontal: 12,
      paddingVertical: 7,
    },
    optionText: {
      flexShrink: 1,
      gap: 1,
    },
    pressed: {
      opacity: 0.7,
    },
    question: {
      color: colors.text,
      fontSize: 17,
      fontWeight: '600',
      lineHeight: 22,
      marginBottom: 4,
      paddingHorizontal: 6,
    },
    skip: {
      justifyContent: 'center',
      minHeight: 44,
      paddingHorizontal: 8,
    },
    skipLabel: {
      color: colors['text-secondary'],
      fontSize: 15,
      fontWeight: '600',
    },
    taken: {
      alignItems: 'center',
      flexDirection: 'row',
      flexShrink: 0,
      gap: 4,
    },
    takenLabel: {
      color: colors.text,
      fontSize: 13,
      fontWeight: '600',
    },
    title: {
      color: colors.text,
      fontSize: 16,
      fontWeight: '600',
      lineHeight: 21,
    },
  });
