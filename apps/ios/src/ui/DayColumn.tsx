import {
  dayRange,
  type EventRecord,
  layoutDayColumn,
  moveEventTimes,
  resizeEventEnd,
  Temporal,
} from '@calendar/core';
import { StyleSheet, View, type DimensionValue } from 'react-native';
import { DraggableEventBlock } from './DraggableEventBlock.tsx';
import { NowIndicator } from './NowIndicator.tsx';
import { palette } from './theme.ts';
import { HOUR_HEIGHT } from './timelineLayout.ts';

/** One day's timed events, sized against that day's own range. */
export function DayColumn({
  colorOf,
  compact,
  date,
  events,
  isToday,
  onCommit,
  onEventPress,
  timeZone,
  width,
}: {
  colorOf: (event: EventRecord) => string;
  compact: boolean;
  date: Temporal.PlainDate;
  /** Timed events touching this day. */
  events: ReadonlyArray<EventRecord>;
  isToday: boolean;
  onCommit: (event: EventRecord, changes: { endUtc?: number; startUtc?: number }) => void;
  onEventPress: (event: EventRecord) => void;
  timeZone: string;
  width: number;
}) {
  const range = dayRange(date, timeZone);
  const boxes = layoutDayColumn(
    events.map((event) => ({
      endUtc: event.endUtc,
      id: `${event.calendarId}:${event.id}`,
      startUtc: event.startUtc,
    })),
    range.startUtc,
    range.endUtc,
  );
  const byId = new Map(events.map((event) => [`${event.calendarId}:${event.id}`, event]));

  return (
    <View style={[styles.dayColumn, compact && styles.dayColumnCompact, { width }]}>
      {boxes.map((box) => {
        const event = byId.get(box.id)!;
        return (
          <DraggableEventBlock
            color={colorOf(event)}
            compact={compact}
            event={event}
            height={Math.max(box.height * 24 * HOUR_HEIGHT, 22)}
            key={box.id}
            left={`${box.left * 100}%` as DimensionValue}
            onCommitMove={(deltaMinutes) => onCommit(event, moveEventTimes(event, deltaMinutes))}
            onCommitResize={(deltaMinutes) => onCommit(event, resizeEventEnd(event, deltaMinutes))}
            onPress={() => onEventPress(event)}
            timeZone={timeZone}
            top={box.top * 24 * HOUR_HEIGHT}
            width={`${box.width * 100}%` as DimensionValue}
          />
        );
      })}

      {isToday ? <NowIndicator rangeEndUtc={range.endUtc} rangeStartUtc={range.startUtc} /> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  dayColumn: {
    height: 24 * HOUR_HEIGHT,
  },
  dayColumnCompact: {
    borderLeftColor: palette.gridLine,
    borderLeftWidth: StyleSheet.hairlineWidth,
  },
});
