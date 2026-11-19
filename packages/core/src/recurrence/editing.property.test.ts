import { expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { Temporal } from '../time/temporal.ts';
import { canSplitRecurrence, remainingRecurrence, truncateRecurrence } from './editing.ts';
import { expandRecurringEvent, type RecurrenceMaster } from './expand.ts';

const Count = Schema.Int.check(Schema.isBetween({ maximum: 20, minimum: 3 }));
const Index = Schema.Int.check(Schema.isBetween({ maximum: 200, minimum: 0 }));
const dates = ['2024-02-25', '2026-03-01', '2026-10-25', '2026-01-28'] as const;
const zones = ['UTC', 'Europe/Vienna', 'America/Los_Angeles', 'Australia/Lord_Howe'] as const;

it.prop(
  'splitting at a rule occurrence partitions the series without loss, overlap or count inflation',
  {
    allDay: Schema.Boolean,
    anchor: Schema.Literals(dates),
    count: Count,
    excluded: Schema.Int.check(Schema.isBetween({ maximum: 2 ** 20 - 1, minimum: 0 })),
    extraDays: Schema.Array(Index).check(Schema.isMaxLength(8)),
    frequency: Schema.Literals(['DAILY', 'WEEKLY']),
    interval: Schema.Literals([1, 2, 7, 14]),
    split: Index,
    zone: Schema.Literals(zones),
  },
  ({ allDay, anchor, count, excluded, extraDays, frequency, interval, split, zone }) => {
    const day = Temporal.PlainDate.from(anchor);
    const stride = interval * (frequency === 'WEEKLY' ? 7 : 1);
    const splitIndex = 1 + (split % (count - 1));
    const instant = (date: Temporal.PlainDate): number =>
      date.toZonedDateTime({
        plainTime: allDay ? '00:00' : '09:30',
        timeZone: allDay ? 'UTC' : zone,
      }).epochMilliseconds;
    // Reference: calendar-date arithmetic, independent of the RRULE parser
    // and of both split helpers. All-day values use floating UTC dates.
    const ruleStarts = Array.from({ length: count }, (_, index) =>
      instant(day.add({ days: index * stride })),
    );
    const cut = ruleStarts[splitIndex]!;
    const extras = extraDays.map((offset) => instant(day.add({ days: offset % (count * stride) })));
    const removed = new Set(
      ruleStarts.filter((_, index) => index !== splitIndex && (excluded & (1 << index)) !== 0),
    );
    const expected = [...new Set([...ruleStarts, ...extras])]
      .filter((start) => !removed.has(start))
      .sort((a, b) => a - b);
    const value = (ms: number): string => {
      const iso = new Date(ms).toISOString();
      return allDay
        ? iso.slice(0, 10).replaceAll('-', '')
        : iso.replaceAll(/[-:]/g, '').replace('.000', '');
    };
    const list = (kind: 'EXDATE' | 'RDATE', values: ReadonlyArray<number>) =>
      `${kind}${allDay ? ';VALUE=DATE' : ''}:${values.map(value).join(',')}`;
    const master: RecurrenceMaster = {
      ...(allDay ? { endDate: day.add({ days: 2 }).toString(), startDate: anchor } : {}),
      endUtc: instant(day) + (allDay ? 2 * 86_400_000 : 90 * 60_000),
      id: 'split-property',
      isAllDay: allDay,
      recurrence: [
        `RRULE:FREQ=${frequency};INTERVAL=${interval};COUNT=${count}`,
        ...(extras.length === 0 ? [] : [list('RDATE', extras)]),
        ...(removed.size === 0 ? [] : [list('EXDATE', [...removed])]),
      ],
      startTimeZone: zone,
      startUtc: instant(day),
    };
    const from = master.startUtc - 1;
    // Include room beyond the original end: an inflated remaining COUNT
    // must surface, rather than hide outside the test's query window.
    const to = instant(day.add({ days: (count * 2 + 1) * stride }));
    const starts = (record: RecurrenceMaster) =>
      expandRecurringEvent(record, from, to).map((occurrence) => occurrence.originalStartUtc);
    expect(starts(master)).toEqual(expected);
    expect(canSplitRecurrence(master, cut)).toBe(true);
    for (const extra of extras) {
      expect(canSplitRecurrence(master, extra)).toBe(ruleStarts.includes(extra));
    }
    const before = {
      ...master,
      recurrence: truncateRecurrence(master.recurrence, cut, allDay, zone),
    };
    const cutDate = day.add({ days: splitIndex * stride });
    const after: RecurrenceMaster = {
      ...master,
      ...(allDay
        ? { endDate: cutDate.add({ days: 2 }).toString(), startDate: cutDate.toString() }
        : {}),
      endUtc: cut + (master.endUtc - master.startUtc),
      id: 'split-property-following',
      recurrence: remainingRecurrence(master, cut),
      startUtc: cut,
    };
    const earlier = starts(before);
    const following = starts(after);
    expect(earlier).toEqual(expected.filter((start) => start < cut));
    expect(following).toEqual(expected.filter((start) => start >= cut));
    expect([...earlier, ...following]).toEqual(expected);
    expect(new Set([...earlier, ...following]).size).toBe(expected.length);
  },
  { arbitrary: { runs: 200 } },
);
