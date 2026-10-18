import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { Glyph, Row } from './GroupedList.tsx';
import { type ThemeColors, useStyles, useTheme } from './theme.ts';

/**
 * The Due row of a task that has no due day: the calendar shows it on
 * today until it is done, and it keeps no date unless one is added here.
 */
export function NoDueDate({ onAdd }: { onAdd: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <Row
      accessory={
        <Pressable
          accessibilityRole="button"
          hitSlop={8}
          onPress={onAdd}
          testID="task-add-due-date"
        >
          <Text style={styles.action}>Add due date</Text>
        </Pressable>
      }
      subtitle="Shown on today until it is done"
      testID="task-no-due-date"
      title="No due date"
    />
  );
}

/**
 * The Due row of a dated task: its date picker (`children`), and the way
 * to take the day away (saved undated: an inbox add, or back to the inbox)
 * unless the model keeps the day (a conversion, a read-only reminder).
 */
export function DueRow({
  children,
  onRemove,
}: {
  children: ReactNode;
  onRemove: (() => void) | undefined;
}) {
  const { colors } = useTheme();
  const styles = useStyles(makeStyles);
  return (
    <Row
      accessory={
        <View style={styles.pair}>
          {children}
          {onRemove ? (
            <Pressable
              accessibilityLabel="No due date"
              accessibilityRole="button"
              hitSlop={8}
              onPress={onRemove}
              testID="task-remove-due-date"
            >
              <Glyph name="xmark.circle.fill" size={20} tintColor={colors['border-strong']} />
            </Pressable>
          ) : null}
        </View>
      }
      title="Due"
    />
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    action: {
      color: colors.primary,
      fontSize: 17,
    },
    pair: {
      alignItems: 'center',
      flexDirection: 'row',
      gap: 8,
    },
  });
