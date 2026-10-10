import {
  rescheduledEventExclusion,
  useFindTimeModel,
  useModelAvailability,
  type useEventEditorModel,
} from '@calendar/app-state';
import {
  FINDER_BOUNDS,
  FINDER_DAYS,
  FINDER_DURATIONS,
  FINDER_WINDOWS,
  formatSlotLabel,
  minutesBetween,
} from '@calendar/core';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { backendClient } from '../backend.ts';
import { languageModel } from '../model.ts';
import { chip, chipLabel, useSheetStyles } from './editSheetShared.ts';
import { onAppActive } from './QuickAddBar.tsx';
import { BOX_FONT_SCALE, type ThemeColors, useStyles } from './theme.ts';

/**
 * "Find a time" under the event's date and times: a few preset chip rows
 * over the pure solver (window, hours, days, duration), a Search, and the
 * free slots as chips — a tap moves the event there. With the on-device
 * model a phrase fills the presets; without it the finder works the
 * same. The duration starts as the form's own.
 */
export function FindTimeFields({ model }: { model: ReturnType<typeof useEventEditorModel> }) {
  const sheetStyles = useSheetStyles();
  const styles = useStyles(makeStyles);
  const { status } = useModelAvailability(languageModel, onAppActive);
  const { existing, scope } = model;
  const finder = useFindTimeModel({
    backend: backendClient,
    contextKey: scope,
    durationMinutes: model.isAllDay ? 60 : minutesBetween(model.startTime, model.endTime),
    // The event being moved is not in its own way: its row, and the
    // occurrences a series edit covers.
    excludeEvent: rescheduledEventExclusion(existing, scope),
    model: languageModel,
    onTitle: (title) => {
      if (model.title.trim() === '') {
        model.setTitle(title);
      }
    },
    timeZone: model.timeZone,
  });

  // An all-day series keeps its kind: no slot could be applied.
  if (model.isAllDay && !model.canSwitchAllDay) {
    return null;
  }
  if (!finder.open) {
    return (
      <Pressable
        accessibilityRole="button"
        onPress={finder.openFinder}
        style={styles.openButton}
        testID="find-time"
      >
        <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.openLabel}>
          Find a time
        </Text>
      </Pressable>
    );
  }
  const row = <T extends string>(
    label: string,
    options: ReadonlyArray<{ readonly label: string; readonly value: T }>,
    selected: T | undefined,
    pick: (value: T) => void,
    testIDPrefix: string,
  ) => (
    <View>
      <Text style={sheetStyles.label}>{label}</Text>
      <View style={sheetStyles.scopeRow}>
        {options.map((option) => (
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: option.value === selected }}
            key={option.value}
            onPress={() => pick(option.value)}
            style={chip(sheetStyles, option.value === selected)}
            testID={`${testIDPrefix}-${option.value}`}
          >
            <Text style={chipLabel(sheetStyles, option.value === selected)}>{option.label}</Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
  return (
    <View style={styles.box} testID="find-time-fields">
      <View style={styles.header}>
        <Text style={styles.eyebrow}>Find a time</Text>
        <Pressable accessibilityRole="button" onPress={finder.close} testID="find-time-close">
          <Text style={styles.closeLabel}>Close</Text>
        </Pressable>
      </View>
      {status === 'ready' ? (
        <View style={styles.phraseRow}>
          <TextInput
            accessibilityLabel="Describe the time you need"
            editable={!finder.busy}
            onChangeText={finder.setPhrase}
            onSubmitEditing={() => void finder.readPhrase()}
            placeholder="90 min focus next week, mornings"
            returnKeyType="go"
            style={styles.phrase}
            testID="find-time-phrase"
            value={finder.phrase}
          />
          <Pressable
            accessibilityRole="button"
            disabled={finder.busy || finder.phrase.trim() === ''}
            onPress={() => void finder.readPhrase()}
            style={[
              styles.secondaryButton,
              (finder.busy || finder.phrase.trim() === '') && styles.disabled,
            ]}
          >
            <Text style={styles.secondaryLabel}>Read</Text>
          </Pressable>
        </View>
      ) : null}
      {row('When', FINDER_WINDOWS, finder.window, finder.setWindow, 'find-time-window')}
      {row('Hours', FINDER_BOUNDS, finder.bounds, finder.setBounds, 'find-time-bounds')}
      {row('Days', FINDER_DAYS, finder.days, finder.setDays, 'find-time-days')}
      {finder.customNote ? (
        <Text style={styles.status} testID="find-time-custom">
          From the phrase: {finder.customNote}
        </Text>
      ) : null}
      {row(
        'Duration',
        FINDER_DURATIONS.map((option) => ({ label: option.label, value: String(option.minutes) })),
        String(finder.constraints.durationMinutes),
        (value) => finder.setDuration(Number(value)),
        'find-time-duration',
      )}
      <View style={styles.actions}>
        <Text style={[styles.status, finder.error ? styles.error : null]}>
          {finder.error ?? ''}
        </Text>
        {finder.busy ? (
          <ActivityIndicator />
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => void finder.search()}
            style={styles.button}
            testID="find-time-search"
          >
            <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.buttonLabel}>
              Search
            </Text>
          </Pressable>
        )}
      </View>
      {finder.slots && finder.slots.length > 0 ? (
        <View style={styles.slots} testID="find-time-slots">
          {finder.slots.map((slot, index) => (
            <Pressable
              accessibilityRole="button"
              key={`${slot.date}T${slot.startTime}`}
              onPress={() => {
                model.applySlot(slot);
                finder.close();
              }}
              style={styles.slotChip}
              testID={`find-time-slot-${index}`}
            >
              <Text style={styles.slotLabel}>{formatSlotLabel(slot)}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    actions: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
      minHeight: 36,
    },
    box: {
      backgroundColor: colors['surface-subtle'],
      borderRadius: 12,
      gap: 10,
      marginBottom: 14,
      padding: 12,
    },
    button: {
      backgroundColor: colors.primary,
      borderRadius: 8,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    buttonLabel: {
      color: colors['on-primary'],
      fontSize: 15,
      fontWeight: '600',
    },
    closeLabel: {
      color: colors['text-secondary'],
      fontSize: 14,
    },
    disabled: {
      opacity: 0.4,
    },
    error: {
      color: colors.danger,
    },
    eyebrow: {
      color: colors.primary,
      fontSize: 12,
      fontWeight: '600',
    },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    openButton: {
      alignSelf: 'flex-start',
      backgroundColor: colors.fill,
      borderRadius: 8,
      marginBottom: 14,
      marginTop: 4,
      paddingHorizontal: 12,
      paddingVertical: 7,
    },
    openLabel: {
      color: colors.text,
      fontSize: 14,
      fontWeight: '600',
    },
    phrase: {
      backgroundColor: colors.fill,
      borderRadius: 8,
      color: colors.text,
      flex: 1,
      fontSize: 15,
      paddingHorizontal: 10,
      paddingVertical: 8,
    },
    phraseRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 8,
    },
    secondaryButton: {
      backgroundColor: colors.fill,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
    },
    secondaryLabel: {
      color: colors.text,
      fontSize: 14,
      fontWeight: '600',
    },
    slotChip: {
      backgroundColor: colors.selection,
      borderRadius: 16,
      paddingHorizontal: 12,
      paddingVertical: 6,
    },
    slotLabel: {
      color: colors['on-selection'],
      fontSize: 14,
    },
    slots: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
    },
    status: {
      color: colors['text-secondary'],
      flex: 1,
      fontSize: 13,
    },
  });
