import type { ModelAvailability } from '@calendar/ai';
import type { AvailabilityCheck } from '@calendar/app-state';
import { SymbolView } from 'expo-symbols';
import { useState } from 'react';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import {
  availabilityDetails,
  availabilityGuidance,
  checkResultLine,
} from '../modelAvailabilityCopy.ts';
import { type ThemeColors, useStyles, useTheme } from './theme.ts';

/**
 * What stands in the quick-add field's place while the model cannot run:
 * why, as iOS reported it, and what to do about it; Check Again, whose
 * answer stays under it (changed or not); and the technical details,
 * collapsed — the status, the reason as iOS named it, a failed check's
 * error — as text to copy into a bug report. It sits in the editor's
 * header, above the form's scroll view, so it stays short: the details
 * are one tap away, not on the half-height sheet by default.
 */
export function ModelAvailabilityNotice({
  availability,
  checkedAt,
  lastManualCheck,
  manualChecking,
  onCheckAgain,
}: {
  availability: ModelAvailability;
  checkedAt: number | null;
  lastManualCheck: AvailabilityCheck | null;
  manualChecking: boolean;
  onCheckAgain: () => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [expanded, setExpanded] = useState(false);
  return (
    <View style={styles.notice} testID="quick-add-notice">
      <Text style={styles.text} testID="quick-add-notice-text">
        {availabilityGuidance(availability, String(Platform.Version))}
      </Text>
      <View style={styles.actions}>
        <Pressable
          accessibilityLabel={
            manualChecking
              ? 'Checking availability'
              : 'Check again whether Apple Intelligence can run'
          }
          accessibilityRole="button"
          accessibilityState={{ busy: manualChecking, disabled: manualChecking }}
          disabled={manualChecking}
          onPress={onCheckAgain}
          style={[styles.button, manualChecking && styles.buttonBusy]}
          testID="quick-add-recheck"
        >
          {manualChecking ? (
            <ActivityIndicator color={colors['text-secondary']} size="small" />
          ) : null}
          <Text style={styles.buttonLabel}>{manualChecking ? 'Checking…' : 'Check Again'}</Text>
        </Pressable>
        <Pressable
          // Its own label: the chevron's image would be read out first.
          accessibilityLabel="Technical details"
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          hitSlop={8}
          onPress={() => setExpanded((open) => !open)}
          style={styles.disclosure}
          testID="quick-add-details-toggle"
        >
          <SymbolView
            name={expanded ? 'chevron.down' : 'chevron.right'}
            size={11}
            tintColor={colors['text-secondary']}
            weight="semibold"
          />
          <Text style={styles.disclosureLabel}>Technical details</Text>
        </Pressable>
      </View>
      {lastManualCheck ? (
        <Text style={styles.result} testID="quick-add-check-result">
          {checkResultLine(lastManualCheck)}
        </Text>
      ) : null}
      {expanded ? (
        <Text selectable style={styles.details} testID="quick-add-details">
          {availabilityDetails(availability, checkedAt)}
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    // Check Again and the disclosure share a row; at large text sizes the
    // disclosure wraps under the button instead of squeezing it.
    actions: {
      alignItems: 'center',
      columnGap: 16,
      flexDirection: 'row',
      flexWrap: 'wrap',
      rowGap: 8,
    },
    button: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 8,
      flexDirection: 'row',
      gap: 6,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    buttonBusy: {
      opacity: 0.6,
    },
    buttonLabel: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '600',
    },
    details: {
      color: colors['text-secondary'],
      fontSize: 13,
      fontVariant: ['tabular-nums'],
    },
    disclosure: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 4,
    },
    disclosureLabel: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    notice: {
      backgroundColor: colors.fill,
      borderRadius: 12,
      gap: 10,
      padding: 14,
    },
    result: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    text: {
      color: colors['text-secondary'],
      fontSize: 14,
    },
  });
