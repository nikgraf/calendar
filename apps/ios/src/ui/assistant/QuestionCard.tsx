import {
  asSaidOption,
  contactOption,
  pickedCandidate,
  placeOptions,
  questionCount,
  questionText,
  readsAsSaid,
  type useThreadEditor,
} from '@calendar/app-state';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { AppleMaps } from '../LocationMap.tsx';
import { BOX_FONT_SCALE, type ThemeColors, useStyles } from '../theme.ts';
import { PlaceMap } from './PlaceMap.tsx';
import { PlaceMapSheet } from './PlaceMapSheet.tsx';
import { QuestionOption } from './QuestionOption.tsx';

/** The question map's height: the question with it fits a 6.1″ iPhone whole. */
const MAP_HEIGHT = 150;

/**
 * What the Assistant asks, one question at a time under its newest card
 * (`questionsAsked`): its number among those its turn brought, the
 * question, the answers as rows and Skip. An answer is a step (going back
 * over it asks again); Skip leaves the form as it is. "Which place?"
 * shows its places on one map above the rows, numbered like them: a pin
 * takes its place as its row does, and the map opens full height
 * (`PlaceMapSheet`). The desktop's card, with the same test ids.
 */
export function QuestionCard({ editor }: { readonly editor: ReturnType<typeof useThreadEditor> }) {
  const styles = useStyles(makeStyles);
  const [expanded, setExpanded] = useState(false);
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
  const keptAsSaid = place ? readsAsSaid(place, eventModel.location, placeGeo) : false;
  const labels = place ? placeOptions(place) : [];
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
            <PlaceMap
              disabled={disabled}
              height={MAP_HEIGHT}
              names={labels.map((label) => label.title)}
              numbered
              onExpand={AppleMaps ? () => setExpanded(true) : undefined}
              onPick={(at) => {
                const candidate = place.candidates[at];
                if (candidate !== undefined) {
                  pickPlaceChoice(candidate);
                }
              }}
              places={place.candidates.map((candidate) => candidate.geo)}
              testID="draft-place-map"
            />
            {place.candidates.map((candidate, at) => (
              <QuestionOption
                disabled={disabled}
                key={`${candidate.source}:${candidate.geo.source}:${String(at)}`}
                label={labels[at] ?? { detail: '', title: '' }}
                lead={at + 1}
                onPress={() => pickPlaceChoice(candidate)}
                selected={held === candidate}
                testID={`draft-place-pick-${String(at)}`}
              />
            ))}
            <QuestionOption
              disabled={disabled}
              label={asSaidOption(place)}
              lead="none"
              onPress={keepPlace}
              selected={keptAsSaid}
              testID="draft-place-keep"
            />
            <PlaceMapSheet
              choice={place}
              disabled={disabled}
              held={held}
              keptAsSaid={keptAsSaid}
              onClose={() => setExpanded(false)}
              onKeep={keepPlace}
              onPick={pickPlaceChoice}
              question={questionText(question)}
              visible={expanded}
            />
          </>
        ) : null}
        {guest
          ? guest.contacts.map((contact, at) => (
              <QuestionOption
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
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      paddingLeft: 6,
    },
    off: {
      opacity: 0.35,
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
  });
