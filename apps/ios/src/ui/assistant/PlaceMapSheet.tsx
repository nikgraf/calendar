import { asSaidOption, type PlaceChoice, placeOptions } from '@calendar/app-state';
import { type PlaceCandidate, placeMapCamera } from '@calendar/core';
import { Modal, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { AppleMaps } from '../LocationMap.tsx';
import { SheetButton } from '../SheetButton.tsx';
import { BOX_FONT_SCALE, type ThemeColors, useStyles, useTheme } from '../theme.ts';
import { QuestionOption } from './QuestionOption.tsx';

/**
 * The question's map at full height (the small map's expand button): a
 * live Apple Maps view to pinch and pan — two places a street apart come
 * apart as it zooms in — with a numbered marker per place on the map, and
 * the question's rows under it. A row takes its place and closes the
 * sheet, as the small map's pins do, and so does a marker. Done closes it
 * as it was.
 */
export function PlaceMapSheet({
  choice,
  disabled,
  held,
  keptAsSaid,
  onClose,
  onKeep,
  onPick,
  question,
  visible,
}: {
  readonly choice: PlaceChoice;
  readonly disabled: boolean;
  /** The place the form holds now, if one of these. */
  readonly held: PlaceCandidate | undefined;
  readonly keptAsSaid: boolean;
  readonly onClose: () => void;
  readonly onKeep: () => void;
  readonly onPick: (candidate: PlaceCandidate) => void;
  readonly question: string;
  readonly visible: boolean;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const insets = useSafeAreaInsets();
  const places = choice.candidates.map((candidate) => candidate.geo);
  const camera = placeMapCamera(places);
  const labels = placeOptions(choice);
  const pick = (candidate: PlaceCandidate | undefined) => {
    if (candidate !== undefined) {
      onPick(candidate);
      onClose();
    }
  };
  return (
    <Modal
      animationType="slide"
      onRequestClose={onClose}
      presentationStyle="pageSheet"
      visible={visible}
    >
      <View style={styles.sheet} testID="draft-place-sheet">
        <View style={styles.header}>
          <Text
            accessibilityRole="header"
            maxFontSizeMultiplier={BOX_FONT_SCALE}
            numberOfLines={2}
            style={styles.title}
          >
            {question}
          </Text>
          <SheetButton label="Done" onPress={onClose} primary testID="draft-place-sheet-done" />
        </View>
        <View style={styles.map}>
          {AppleMaps && camera ? (
            <AppleMaps.View
              cameraPosition={{
                coordinates: { latitude: camera.center.lat, longitude: camera.center.lng },
                zoom: camera.zoom,
              }}
              markers={choice.candidates.map((candidate, index) => ({
                coordinates: { latitude: candidate.geo.lat, longitude: candidate.geo.lng },
                id: String(index),
                monogram: String(index + 1),
                tintColor: colors.primary,
                title: labels[index]?.title ?? '',
              }))}
              onMarkerClick={(marker) => {
                if (!disabled) {
                  pick(choice.candidates[Number(marker.id)]);
                }
              }}
              properties={{ isMyLocationEnabled: false }}
              style={StyleSheet.absoluteFill}
              uiSettings={{
                compassEnabled: false,
                myLocationButtonEnabled: false,
                togglePitchEnabled: false,
              }}
            />
          ) : null}
        </View>
        <ScrollView
          contentContainerStyle={[styles.rows, { paddingBottom: insets.bottom + 12 }]}
          style={styles.list}
        >
          {choice.candidates.map((candidate, index) => (
            <QuestionOption
              disabled={disabled}
              key={`${candidate.source}:${candidate.geo.source}:${String(index)}`}
              label={labels[index] ?? { detail: '', title: '' }}
              lead={index + 1}
              onPress={() => pick(candidate)}
              selected={held === candidate}
              testID={`draft-place-sheet-pick-${String(index)}`}
            />
          ))}
          <QuestionOption
            disabled={disabled}
            label={asSaidOption(choice)}
            lead="none"
            onPress={() => {
              onKeep();
              onClose();
            }}
            selected={keptAsSaid}
            testID="draft-place-sheet-keep"
          />
        </ScrollView>
      </View>
    </Modal>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 12,
      justifyContent: 'space-between',
      paddingHorizontal: 20,
      paddingVertical: 10,
    },
    list: {
      backgroundColor: colors['surface-subtle'],
      flexGrow: 0,
      maxHeight: '45%',
    },
    map: {
      backgroundColor: colors.fill,
      flex: 1,
    },
    rows: {
      gap: 6,
      paddingHorizontal: 16,
      paddingTop: 12,
    },
    sheet: {
      backgroundColor: colors.surface,
      flex: 1,
    },
    title: {
      color: colors.text,
      flexShrink: 1,
      fontSize: 17,
      fontWeight: '600',
      lineHeight: 22,
    },
  });
