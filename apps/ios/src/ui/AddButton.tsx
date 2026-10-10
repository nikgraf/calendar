import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { BOX_FONT_SCALE, type ThemeColors, useStyles } from './theme.ts';

/**
 * iOS 26 floats the tab bar's items and detaches Search; before that the
 * bar is a solid strip across the screen that would cover "+" and take its
 * taps. `Platform.Version` is a string like "26.0" on iOS.
 */
export const FLOATING_TAB_BAR =
  Platform.OS === 'ios' && Number.parseInt(String(Platform.Version), 10) >= 26;
/**
 * iOS 26's floating tab bar on iPhone: its items are 62pt tall, top-aligned
 * with the bar's frame, and the Search circle keeps a 21pt margin to the
 * screen's right edge (the same on the SE 3, 17e, 17 Pro and 17 Pro Max
 * simulators, iOS 26.5). "+" takes the circle's size and sits 10pt to its
 * left, as drawn.
 */
const TAB_BAR_ITEM = 62;
const SEARCH_RIGHT = 21;
const FAB_GAP = 10;
/** Below iOS 26: a 56pt FAB, 20pt in from the edge and above the bar. */
const FAB = 56;
const FAB_INSET = 20;
/** How far above the safe area's bottom the notices must stand to clear the button. */
export const ADD_BUTTON_CLEARANCE = FLOATING_TAB_BAR ? 0 : FAB_INSET + FAB;

/**
 * The "+" of the Calendar and Tasks tabs. Rendered as the last child of
 * the tab's safe area: that area ends at the native tab bar's top edge,
 * so this empty row sits there. On iOS 26 "+" hangs from it into the bar,
 * level with the Search tab's circle (the search role is drawn as its own
 * circle at the bottom right, and the bar lets taps between its items
 * through); before that it floats above.
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
        style={[styles.fab, FLOATING_TAB_BAR ? styles.fabInBar : styles.fabAboveBar]}
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
      elevation: 4,
      justifyContent: 'center',
      position: 'absolute',
      shadowColor: '#000000',
      shadowOffset: { height: 4, width: 0 },
      shadowOpacity: 0.2,
      shadowRadius: 8,
    },
    fabAboveBar: {
      borderRadius: FAB / 2,
      bottom: FAB_INSET,
      height: FAB,
      right: FAB_INSET,
      width: FAB,
    },
    fabInBar: {
      borderRadius: TAB_BAR_ITEM / 2,
      height: TAB_BAR_ITEM,
      right: SEARCH_RIGHT + TAB_BAR_ITEM + FAB_GAP,
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
