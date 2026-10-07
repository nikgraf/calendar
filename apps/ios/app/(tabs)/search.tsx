import { StyleSheet, Text, View } from 'react-native';

/** The Search tab: a placeholder until search ships in its own PR. */
export default function SearchScreen() {
  return (
    <View style={styles.screen} testID="search-screen">
      <Text style={styles.note}>Search is coming soon.</Text>
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
