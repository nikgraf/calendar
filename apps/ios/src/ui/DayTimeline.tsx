import { useNow } from '@calendar/app-state';
import { dayRange, layoutDayColumn, Temporal, type EventRecord } from '@calendar/core';
import { useEffect, useRef } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { chipTextColor, palette } from './theme.ts';

const HOUR_HEIGHT = 56;

const formatTime = (epochMs: number, timeZone: string): string =>
  Temporal.Instant.fromEpochMilliseconds(epochMs)
    .toZonedDateTimeISO(timeZone)
    .toPlainTime()
    .toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });

export function DayTimeline({
  colorOf,
  date,
  events,
  timeZone,
}: {
  colorOf: (event: EventRecord) => string;
  date: Temporal.PlainDate;
  events: ReadonlyArray<EventRecord>;
  timeZone: string;
}) {
  const scrollRef = useRef<ScrollView>(null);
  const nowMs = useNow();
  const range = dayRange(date, timeZone);
  const isToday = Temporal.PlainDate.compare(date, Temporal.Now.plainDateISO(timeZone)) === 0;

  useEffect(() => {
    scrollRef.current?.scrollTo({ animated: false, y: 7.5 * HOUR_HEIGHT });
  }, []);

  const allDay = events.filter(
    (event) => event.isAllDay && event.startUtc < range.endUtc && event.endUtc > range.startUtc,
  );
  const timed = events.filter(
    (event) => !event.isAllDay && event.startUtc < range.endUtc && event.endUtc > range.startUtc,
  );
  const boxes = layoutDayColumn(
    timed.map((event) => ({
      endUtc: event.endUtc,
      id: `${event.calendarId}:${event.id}`,
      startUtc: event.startUtc,
    })),
    range.startUtc,
    range.endUtc,
  );
  const byId = new Map(timed.map((event) => [`${event.calendarId}:${event.id}`, event]));
  const nowFraction = (nowMs - range.startUtc) / (range.endUtc - range.startUtc);

  return (
    <View style={styles.container}>
      {allDay.length > 0 ? (
        <View style={styles.allDayLane}>
          {allDay.map((event) => {
            const color = colorOf(event);
            return (
              <View
                key={`${event.calendarId}:${event.id}`}
                style={[styles.allDayChip, { backgroundColor: color }]}
              >
                <Text
                  numberOfLines={1}
                  style={[styles.allDayText, { color: chipTextColor(color) }]}
                >
                  {event.title}
                </Text>
              </View>
            );
          })}
        </View>
      ) : null}

      <ScrollView ref={scrollRef} style={styles.scroll}>
        <View style={{ height: 24 * HOUR_HEIGHT }}>
          {Array.from({ length: 24 }, (_, hour) => (
            <View key={hour} style={[styles.hourRow, { top: hour * HOUR_HEIGHT }]}>
              <Text style={styles.hourLabel}>
                {hour === 0
                  ? ''
                  : new Temporal.PlainTime(hour).toLocaleString('en-US', {
                      hour: 'numeric',
                    })}
              </Text>
              <View style={styles.hourLine} />
            </View>
          ))}

          <View style={styles.eventsArea}>
            {boxes.map((box) => {
              const event = byId.get(box.id)!;
              const color = colorOf(event);
              const height = Math.max(box.height * 24 * HOUR_HEIGHT, 22);
              return (
                <View
                  key={box.id}
                  style={[
                    styles.eventBlock,
                    {
                      backgroundColor: color,
                      height: height - 2,
                      left: `${box.left * 100}%`,
                      top: box.top * 24 * HOUR_HEIGHT,
                      width: `${box.width * 100}%`,
                    },
                  ]}
                >
                  <Text
                    numberOfLines={1}
                    style={[styles.eventTitle, { color: chipTextColor(color) }]}
                  >
                    {event.title}
                  </Text>
                  {height > 34 ? (
                    <Text
                      numberOfLines={1}
                      style={[styles.eventTime, { color: chipTextColor(color) }]}
                    >
                      {formatTime(event.startUtc, timeZone)} – {formatTime(event.endUtc, timeZone)}
                    </Text>
                  ) : null}
                </View>
              );
            })}

            {isToday && nowFraction >= 0 && nowFraction <= 1 ? (
              <View style={[styles.nowLine, { top: nowFraction * 24 * HOUR_HEIGHT }]}>
                <View style={styles.nowDot} />
              </View>
            ) : null}
          </View>
        </View>
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  allDayChip: {
    borderRadius: 6,
    marginBottom: 3,
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  allDayLane: {
    borderBottomColor: palette.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  allDayText: {
    fontSize: 13,
    fontWeight: '500',
  },
  container: {
    flex: 1,
  },
  eventBlock: {
    borderRadius: 6,
    paddingHorizontal: 6,
    paddingVertical: 2,
    position: 'absolute',
  },
  eventsArea: {
    bottom: 0,
    left: 56,
    position: 'absolute',
    right: 8,
    top: 0,
  },
  eventTime: {
    fontSize: 11,
    opacity: 0.85,
  },
  eventTitle: {
    fontSize: 13,
    fontWeight: '600',
  },
  hourLabel: {
    color: palette.textFaint,
    fontSize: 10,
    textAlign: 'right',
    transform: [{ translateY: -6 }],
    width: 44,
  },
  hourLine: {
    backgroundColor: palette.gridLine,
    flex: 1,
    height: StyleSheet.hairlineWidth,
    marginLeft: 6,
  },
  hourRow: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    left: 0,
    position: 'absolute',
    right: 0,
  },
  nowDot: {
    backgroundColor: palette.today,
    borderRadius: 4,
    height: 8,
    left: -4,
    position: 'absolute',
    top: -3,
    width: 8,
  },
  nowLine: {
    backgroundColor: palette.today,
    height: 2,
    left: 0,
    position: 'absolute',
    right: 0,
    zIndex: 10,
  },
  scroll: {
    flex: 1,
  },
});
