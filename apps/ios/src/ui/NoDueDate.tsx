import { Pressable, StyleSheet, Text, View } from 'react-native';
import { sheetStyles } from './editSheetShared.ts';
import { palette } from './theme.ts';

/**
 * The Due row of a task that has no due day: the calendar shows it on
 * today until it is done, and it keeps no date unless one is added here.
 */
export function NoDueDate({ onAdd }: { onAdd: () => void }) {
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

const styles = StyleSheet.create({
  action: {
    color: '#2563eb',
    fontSize: 15,
  },
  note: {
    color: palette.textMuted,
    fontSize: 13,
  },
  text: {
    flex: 1,
    paddingRight: 12,
  },
});
