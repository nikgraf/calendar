import { StyleSheet, Text, View } from 'react-native';

/** The Tasks tab: the inbox lands here in a later commit. */
export default function TasksScreen() {
  return (
    <View style={styles.screen} testID="tasks-screen">
      <Text style={styles.note}>Tasks</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  note: {
    color: '#737373',
    fontSize: 15,
  },
  screen: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
});
