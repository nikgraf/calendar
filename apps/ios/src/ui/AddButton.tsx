import { Pressable, StyleSheet, Text, View } from 'react-native';
import { BOX_FONT_SCALE, type ThemeColors, useStyles } from './theme.ts';

/**
 * The floating tab bar on iPhone: its items are 62pt tall, top-aligned
 * with the bar's frame, and the Search circle keeps a 21pt margin to the
 * screen's right edge (the same on the SE 3, 17e, 17 Pro and 17 Pro Max
 * simulators on iOS 26.5, and the 18 Pro on iOS 27.2). "+" takes the
 * circle's size and sits 10pt to its left, as drawn.
 */
const TAB_BAR_ITEM = 62;
const SEARCH_RIGHT = 21;
const FAB_GAP = 10;

/**
 * The "+" of the Calendar and Tasks tabs. Rendered as the last child of
 * the tab's safe area: that area ends at the native tab bar's top edge,
 * so this empty row sits there. "+" hangs from it into the bar, level
 * with the Search tab's circle (the search role is drawn as its own circle
 * at the bottom right, and the bar lets taps between its items through).
 */
export function AddButton({ onPress }: { onPress: () => void }) {
  const styles = useStyles(makeStyles);
  return (
    <View pointerEvents="box-none" style={styles.tabBarRow}>
      <Pressable
        accessibilityLabel="Add"
        accessibilityLargeContentTitle="Add"
        accessibilityRole="button"
        accessibilityShowsLargeContentViewer
        onPress={onPress}
        style={styles.fab}
        testID="add"
      >
        <Text maxFontSizeMultiplier={BOX_FONT_SCALE} style={styles.fabLabel}>
          ＋
        </Text>
      </Pressable>
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    fab: {
      alignItems: 'center',
      backgroundColor: colors.primary,
      borderRadius: TAB_BAR_ITEM / 2,
      elevation: 4,
      height: TAB_BAR_ITEM,
      justifyContent: 'center',
      position: 'absolute',
      right: SEARCH_RIGHT + TAB_BAR_ITEM + FAB_GAP,
      shadowColor: '#000000',
      shadowOffset: { height: 4, width: 0 },
      shadowOpacity: 0.2,
      shadowRadius: 8,
      top: 0,
      width: TAB_BAR_ITEM,
    },
    fabLabel: {
      color: colors['on-primary'],
      fontSize: 28,
      fontWeight: '600',
      lineHeight: 32,
    },
    tabBarRow: {
      height: 0,
    },
  });
