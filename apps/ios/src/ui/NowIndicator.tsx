import { useNow } from '@calendar/app-state';
import { StyleSheet, View } from 'react-native';
import { palette } from './theme.ts';
import { HOUR_HEIGHT } from './timelineLayout.ts';

/**
 * The red "now" line in today's column. It owns the minute tick, so the
 * clock re-renders this one view instead of every column.
 */
export function NowIndicator({
  rangeEndUtc,
  rangeStartUtc,
}: {
  rangeEndUtc: number;
  rangeStartUtc: number;
}) {
  const nowMs = useNow();
  const fraction = (nowMs - rangeStartUtc) / (rangeEndUtc - rangeStartUtc);
  if (fraction < 0 || fraction > 1) {
    return null;
  }
  return (
    <View style={[styles.line, { top: fraction * 24 * HOUR_HEIGHT }]}>
      <View style={styles.dot} />
    </View>
  );
}

const styles = StyleSheet.create({
  dot: {
    backgroundColor: palette.today,
    borderRadius: 4,
    height: 8,
    left: -4,
    position: 'absolute',
    top: -3,
    width: 8,
  },
  line: {
    backgroundColor: palette.today,
    height: 2,
    left: 0,
    position: 'absolute',
    right: 0,
    zIndex: 10,
  },
});
