import { FLOW_DOWNLOADS, FLOW_MODELS, type FlowModel, flowSteps, sizeLabel } from '@calendar/ai';
import { StyleSheet, Text, View } from 'react-native';
import { type ThemeColors, useStyles } from '../theme.ts';

/**
 * How the Assistant works, as steps down a rail: what is said, the speech
 * model, the phrases model, the card to save (`flowSteps`). A step that
 * runs on a download carries that model's size (and "optional" for the
 * speech model). `compact` for the Create
 * lesson's "How it works", with where the downloads come from under it
 * (Settings › Assistant says that in its footer); full size there.
 */
export function AssistantFlow({
  compact = false,
  sizes,
}: {
  compact?: boolean;
  /** Each model's size, for its tag. */
  sizes: Readonly<Record<FlowModel, number>>;
}) {
  const styles = useStyles(makeStyles);
  const steps = flowSteps('iPhone');
  return (
    <View accessibilityRole="list" testID="assistant-flow">
      {steps.map((step, index) => {
        const last = index === steps.length - 1;
        const model = step.model === undefined ? undefined : FLOW_MODELS[step.model];
        return (
          <View
            accessibilityLabel={`Step ${String(index + 1)} of ${String(steps.length)}: ${step.title}. ${step.text}${model === undefined || step.model === undefined ? '' : ` ${model.name}, ${sizeLabel(sizes[step.model])}${model.optional ? ', optional' : ''}.`}`}
            accessible
            key={step.title}
            style={styles.step}
            testID={`assistant-flow-step-${String(index + 1)}`}
          >
            <View style={styles.rail}>
              <View style={[styles.dot, compact && styles.dotCompact]}>
                <Text style={[styles.number, compact && styles.numberCompact]}>
                  {String(index + 1)}
                </Text>
              </View>
              {last ? null : <View style={styles.line} />}
            </View>
            <View style={[styles.body, !last && (compact ? styles.gapCompact : styles.gap)]}>
              <Text style={[styles.title, compact && styles.titleCompact]}>{step.title}</Text>
              <Text style={[styles.text, compact && styles.textCompact]}>{step.text}</Text>
              {model === undefined || step.model === undefined ? null : (
                <View style={styles.tag}>
                  <Text style={styles.tagLabel}>
                    {sizeLabel(sizes[step.model])}
                    {model.optional ? ' · optional' : ''}
                  </Text>
                </View>
              )}
            </View>
          </View>
        );
      })}
      {compact ? (
        <Text style={[styles.text, styles.textCompact, styles.note]}>{FLOW_DOWNLOADS}</Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    body: {
      flex: 1,
      paddingTop: 1,
    },
    dot: {
      alignItems: 'center',
      backgroundColor: colors.primary,
      borderRadius: 13,
      height: 26,
      justifyContent: 'center',
      width: 26,
    },
    dotCompact: {
      borderRadius: 10,
      height: 20,
      width: 20,
    },
    gap: {
      paddingBottom: 18,
    },
    gapCompact: {
      paddingBottom: 10,
    },
    /** Joins a step's number to the next one's. */
    line: {
      backgroundColor: colors.border,
      flex: 1,
      marginVertical: 3,
      width: 2,
    },
    note: {
      marginTop: 8,
    },
    number: {
      color: colors['on-primary'],
      fontSize: 13,
      fontWeight: '700',
    },
    numberCompact: {
      fontSize: 11,
    },
    rail: {
      alignItems: 'center',
      width: 26,
    },
    step: {
      flexDirection: 'row',
      gap: 12,
    },
    tag: {
      alignSelf: 'flex-start',
      backgroundColor: colors.fill,
      borderRadius: 999,
      marginTop: 6,
      paddingHorizontal: 9,
      paddingVertical: 3,
    },
    tagLabel: {
      color: colors['text-secondary'],
      fontSize: 12,
      fontWeight: '600',
    },
    text: {
      color: colors['text-secondary'],
      fontSize: 14,
      lineHeight: 19,
      marginTop: 2,
    },
    textCompact: {
      fontSize: 13,
      lineHeight: 18,
    },
    title: {
      color: colors.text,
      fontSize: 16,
      fontWeight: '600',
    },
    titleCompact: {
      fontSize: 13,
    },
  });
