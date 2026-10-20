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
} from '@calendar/core';
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { backendClient } from '../backend.ts';
import { languageModel } from '../model.ts';
import { Chip } from './Chip.tsx';
import { ActionRow, RowSlot } from './GroupedList.tsx';
import { onAppActive } from './QuickAddBar.tsx';
import { BOX_FONT_SCALE, type ThemeColors, useStyles, useTheme } from './theme.ts';

/**
 * "Find a time" at the foot of the event's dates card: a row that opens
 * the finder in its place — a few preset chip rows over the pure solver
 * (window, hours, days, duration), a Search, and the free slots as chips,
 * a tap moving the event there. With the on-device model a phrase fills
 * the presets; without it the finder works the same. The duration starts
 * as the form's own.
 */
export function FindTimeFields({ model }: { model: ReturnType<typeof useEventEditorModel> }) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { status } = useModelAvailability(languageModel, onAppActive);
  const { existing, scope } = model;
  const finder = useFindTimeModel({
    backend: backendClient,
    contextKey: `${scope}:${model.masterSeries?.startUtc ?? ''}:${model.masterSeries?.recurrence?.join('|') ?? ''}`,
    durationMinutes: model.durationMinutes,
    // What the save will move or drop is not in its own way.
    excludeEvent: rescheduledEventExclusion(existing, scope, model.masterSeries),
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
    return <ActionRow onPress={finder.openFinder} testID="find-time" title="Find a time" />;
  }
  const row = <T extends string>(
    label: string,
    options: ReadonlyArray<{ readonly label: string; readonly value: T }>,
    selected: T | undefined,
    pick: (value: T) => void,
    testIDPrefix: string,
  ) => (
    <View style={styles.group}>
      <Text style={styles.groupLabel}>{label}</Text>
      <View style={styles.chips}>
        {options.map((option) => (
          <Chip
            key={option.value}
            label={option.label}
            onPress={() => pick(option.value)}
            selected={option.value === selected}
            testID={`${testIDPrefix}-${option.value}`}
          />
        ))}
      </View>
    </View>
  );
  return (
    <RowSlot testID="find-time-fields">
      <View style={styles.header}>
        <Text style={styles.eyebrow}>Find a time</Text>
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={finder.close}
          testID="find-time-close"
        >
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
            placeholderTextColor={colors['text-secondary']}
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
        <View style={styles.chips} testID="find-time-slots">
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
    </RowSlot>
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
    button: {
      backgroundColor: colors.primary,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    buttonLabel: {
      color: colors['on-primary'],
      fontSize: 15,
      fontWeight: '600',
    },
    chips: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
    },
    closeLabel: {
      color: colors['text-secondary'],
      fontSize: 15,
    },
    disabled: {
      opacity: 0.4,
    },
    error: {
      color: colors.danger,
    },
    eyebrow: {
      color: colors.text,
      fontSize: 17,
      fontWeight: '600',
    },
    group: {
      gap: 8,
    },
    groupLabel: {
      color: colors['text-secondary'],
      fontSize: 13,
      fontWeight: '600',
    },
    header: {
      alignItems: 'center',
      flexDirection: 'row',
      justifyContent: 'space-between',
    },
    phrase: {
      backgroundColor: colors.fill,
      borderRadius: 10,
      color: colors.text,
      flex: 1,
      fontSize: 15,
      paddingHorizontal: 12,
      paddingVertical: 9,
    },
    phraseRow: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 8,
    },
    secondaryButton: {
      backgroundColor: colors.fill,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 9,
    },
    secondaryLabel: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '600',
    },
    slotChip: {
      backgroundColor: colors.selection,
      borderRadius: 999,
      paddingHorizontal: 14,
      paddingVertical: 7,
    },
    slotLabel: {
      color: colors['on-selection'],
      fontSize: 15,
    },
    status: {
      color: colors['text-secondary'],
      flex: 1,
      fontSize: 13,
    },
  });
