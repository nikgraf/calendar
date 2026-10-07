import { StyleSheet, Text, View } from 'react-native';
import { type ThemeColors, useStyles } from '../../src/ui/theme.ts';

/** The Tasks tab: the inbox lands here in a later commit. */
export default function TasksScreen() {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.screen} testID="tasks-screen">
      <Text style={styles.note}>Tasks</Text>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    note: {
      color: colors['text-secondary'],
      fontSize: 15,
    },
    screen: {
      alignItems: 'center',
      backgroundColor: colors.canvas,
      flex: 1,
      justifyContent: 'center',
    },
  });
