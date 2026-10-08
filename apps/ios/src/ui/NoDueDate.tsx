import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSheetStyles } from './editSheetShared.ts';
import { type ThemeColors, useStyles } from './theme.ts';

/**
 * The Due row of a task that has no due day: the calendar shows it on
 * today until it is done, and it keeps no date unless one is added here.
 */
export function NoDueDate({ onAdd }: { onAdd: () => void }) {
  const sheetStyles = useSheetStyles();
  const styles = useStyles(makeStyles);
  return (
    <View style={sheetStyles.pickerRow} testID="task-no-due-date">
      <View style={styles.text}>
        <Text style={sheetStyles.label}>Due</Text>
        <Text style={styles.note}>No due date — shown on today until it is done.</Text>
      </View>
      <Pressable accessibilityRole="button" onPress={onAdd} testID="task-add-due-date">
        <Text style={styles.action}>Add due date</Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    action: {
      color: colors.primary,
      fontSize: 15,
    },
    note: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    text: {
      flex: 1,
      paddingRight: 12,
    },
  });
