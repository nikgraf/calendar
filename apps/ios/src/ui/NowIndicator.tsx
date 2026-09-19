import { useNow } from '@calendar/app-state';
import { Temporal, wallClockMinutes } from '@calendar/core';
import { StyleSheet, View } from 'react-native';
import { palette } from './theme.ts';
import { HOUR_HEIGHT } from './timelineLayout.ts';

/**
 * The red "now" line in today's column. It owns the minute tick, so the
 * clock re-renders this one view instead of every column. It never takes
 * touches: a hold on the line belongs to the event (or the empty timeline)
 * under it.
 */
export function NowIndicator({ date, timeZone }: { date: Temporal.PlainDate; timeZone: string }) {
  const nowMs = useNow();
  // The column can outlive midnight until its parent re-renders.
  if (
    !Temporal.Instant.fromEpochMilliseconds(nowMs)
      .toZonedDateTimeISO(timeZone)
      .toPlainDate()
      .equals(date)
  ) {
    return null;
  }
  const fraction = wallClockMinutes(nowMs, timeZone) / (24 * 60);
  return (
    <View pointerEvents="none" style={[styles.line, { top: fraction * 24 * HOUR_HEIGHT }]}>
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
