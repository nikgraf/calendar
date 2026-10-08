import { StyleSheet, Text, View } from 'react-native';
import { type ThemeColors, useStyles } from '../../src/ui/theme.ts';

/** The Search tab: a placeholder until search ships in its own PR. */
export default function SearchScreen() {
  const styles = useStyles(makeStyles);
  return (
    <View style={styles.screen} testID="search-screen">
      <Text style={styles.note}>Search is coming soon.</Text>
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
