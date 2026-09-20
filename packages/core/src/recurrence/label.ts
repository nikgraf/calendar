import { Temporal } from '../time/temporal.ts';
import type { RecurrenceRuleSpec } from './build.ts';
import { isWeekdays, isWeekend, ORDINAL_NAMES, sortByDay, WEEKDAY_NAMES } from './byDay.ts';

const UNIT: Record<RecurrenceRuleSpec['freq'], readonly [string, string]> = {
  daily: ['Daily', 'days'],
  monthly: ['Monthly', 'months'],
  weekly: ['Weekly', 'weeks'],
  yearly: ['Yearly', 'years'],
};

/**
 * The rule in Reminders.app's words: "Weekly on weekends", "Every 2 weeks
 * on Monday, Wednesday", "Monthly on the 2nd Tuesday", "Daily, 10 times",
 * "Yearly, until Sep 30, 2026". The editors show it under the controls.
 */
export const recurrenceLabel = (spec: RecurrenceRuleSpec): string => {
  const [every, unit] = UNIT[spec.freq];
  const interval = spec.interval ?? 1;
  let text = interval > 1 ? `Every ${String(interval)} ${unit}` : every;
  const days = sortByDay(spec.byDay ?? []);
  if (days.length > 0 && spec.freq === 'weekly') {
    const weekdays = days.map((day) => day.weekday);
    text += isWeekend(weekdays)
      ? ' on weekends'
      : isWeekdays(weekdays)
        ? ' on weekdays'
        : ` on ${weekdays.map((weekday) => WEEKDAY_NAMES[weekday].long).join(', ')}`;
  } else if (days.length > 0 && spec.freq === 'monthly') {
    const [day] = days;
    if (day !== undefined && day.ordinal !== undefined) {
      const ordinal =
        ORDINAL_NAMES[day.ordinal as keyof typeof ORDINAL_NAMES] ?? String(day.ordinal);
      text += ` on the ${ordinal} ${WEEKDAY_NAMES[day.weekday].long}`;
    }
  }
  if (spec.count !== undefined && spec.count > 0) {
    text += `, ${String(spec.count)} ${spec.count === 1 ? 'time' : 'times'}`;
  } else if (spec.untilDate) {
    text += `, until ${Temporal.PlainDate.from(spec.untilDate).toLocaleString('en-US', {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    })}`;
  }
  return text;
};
