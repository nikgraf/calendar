import { describe, expect, it } from 'vitest';
import { toRRuleLines, toStructuredRules, unsupportedRuleParts } from './structured.ts';

describe('toStructuredRules', () => {
  it('round-trips the parts EventKit can store', () => {
    const cases: ReadonlyArray<readonly [string, boolean]> = [
      ['RRULE:FREQ=DAILY', false],
      ['RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE,FR', false],
      ['RRULE:FREQ=MONTHLY;COUNT=6;BYDAY=-1FR', false],
      ['RRULE:FREQ=MONTHLY;BYMONTHDAY=1,15', false],
      ['RRULE:FREQ=YEARLY;BYDAY=2SU;BYMONTH=3', false],
      ['RRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1', false],
      ['RRULE:FREQ=WEEKLY;UNTIL=20270101T120000Z', false],
      ['RRULE:FREQ=YEARLY;UNTIL=20300301', true],
    ];
    for (const [line, isAllDay] of cases) {
      const { rules, unsupported } = toStructuredRules([line], isAllDay);
      expect(unsupported).toEqual([]);
      expect(toRRuleLines(rules, isAllDay)).toEqual([line]);
    }
  });

  it('reads UNTIL values as the rule means them', () => {
    const [utc] = toStructuredRules(['RRULE:FREQ=DAILY;UNTIL=20270101T120000Z'], false).rules;
    expect(utc?.untilUtc).toBe(Date.UTC(2027, 0, 1, 12));
    const [floating] = toStructuredRules(
      ['RRULE:FREQ=DAILY;UNTIL=20270101T120000'],
      false,
      'Europe/Vienna',
    ).rules;
    expect(floating?.untilUtc).toBe(Date.UTC(2027, 0, 1, 11));
    const [allDay] = toStructuredRules(['RRULE:FREQ=DAILY;UNTIL=20270101'], true).rules;
    expect(allDay?.untilDate).toBe('2027-01-01');
  });

  it('keeps multiple RRULE lines as multiple rules', () => {
    const lines = ['RRULE:FREQ=WEEKLY;BYDAY=MO', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=1'];
    const { rules } = toStructuredRules(lines, false);
    expect(toRRuleLines(rules, false)).toEqual(lines);
  });

  it('names every line and part EventKit cannot store', () => {
    expect(
      toStructuredRules(
        [
          'RRULE:FREQ=DAILY;BYHOUR=9,17',
          'EXDATE;TZID=Europe/Vienna:20260714T090000',
          'RDATE:20260801T090000Z',
          'RRULE:FREQ=WEEKLY;WKST=SU;BYDAY=MO',
          'RRULE:FREQ=DAILY;COUNT=3;UNTIL=20270101T000000Z',
          'RRULE:FREQ=HOURLY',
        ],
        false,
      ).unsupported,
    ).toEqual(['BYHOUR', 'COUNT+UNTIL', 'EXDATE', 'FREQ=HOURLY', 'RDATE', 'WKST']);
  });

  it('drops only the unsupported lines from the result', () => {
    const { rules, unsupported } = toStructuredRules(
      ['RRULE:FREQ=WEEKLY', 'EXDATE:20260714T090000Z'],
      false,
    );
    expect(rules).toHaveLength(1);
    expect(unsupported).toEqual(['EXDATE']);
    expect(unsupportedRuleParts(undefined, false)).toEqual([]);
  });
});
