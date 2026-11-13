import { Pressable, StyleSheet, Text, View } from 'react-native';
import { type AssistantModelState, type NetworkReading, noticeCopy } from '@calendar/ai';
import { BOX_FONT_SCALE, type ThemeColors, useStyles } from '../theme.ts';

/**
 * What stands in the Assistant's place while its model is not on this
 * iPhone yet: the download's progress and that the Assistant will be
 * available soon, or what the person can do — download it (the size
 * said), let it use mobile data, try again. The form works meanwhile.
 */

export function AssistantModelNotice({
  network,
  onAction,
  size,
  state,
}: {
  network: NetworkReading | undefined;
  onAction: (kind: 'download' | 'mobile' | 'retry') => void;
  size: number | undefined;
  state: AssistantModelState;
}) {
  const styles = useStyles(makeStyles);
  const copy = noticeCopy(state, { device: 'iPhone', network, size });
  return (
    <View style={styles.notice} testID="assistant-model-notice">
      {copy.lines.map((line, index) => (
        <Text
          key={line}
          maxFontSizeMultiplier={BOX_FONT_SCALE}
          style={index === 0 ? styles.lead : styles.text}
          testID={index === 0 ? 'assistant-model-notice-text' : undefined}
        >
          {line}
        </Text>
      ))}
      {copy.progress === undefined ? null : (
        <View
          accessibilityLabel={`${String(copy.progress)} percent downloaded`}
          accessibilityRole="progressbar"
          accessibilityValue={{ max: 100, min: 0, now: copy.progress }}
          style={styles.track}
        >
          <View style={[styles.bar, { width: `${String(copy.progress)}%` }]} />
        </View>
      )}
      {copy.action === undefined ? null : (
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            if (copy.action) {
              onAction(copy.action.kind);
            }
          }}
          style={styles.button}
          testID={`assistant-model-${copy.action.kind}`}
        >
          <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.buttonLabel}>
            {copy.action.label}
          </Text>
        </Pressable>
      )}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    bar: {
      backgroundColor: colors.primary,
      borderRadius: 3,
      height: 6,
    },
    button: {
      alignSelf: 'flex-start',
      backgroundColor: colors.fill,
      borderRadius: 10,
      paddingHorizontal: 14,
      paddingVertical: 8,
    },
    buttonLabel: {
      color: colors.text,
      fontSize: 15,
      fontWeight: '600',
    },
    lead: {
      color: colors.text,
      fontSize: 15,
      fontVariant: ['tabular-nums'],
    },
    // A card on the thread's ground, where the conversation would start.
    notice: {
      backgroundColor: colors.surface,
      borderRadius: 14,
      gap: 10,
      padding: 16,
    },
    text: {
      color: colors['text-secondary'],
      fontSize: 14,
    },
    track: {
      backgroundColor: colors.fill,
      borderRadius: 3,
      height: 6,
      overflow: 'hidden',
    },
  });
