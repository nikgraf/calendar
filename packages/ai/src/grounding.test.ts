import { FINDER_BOUNDS } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import {
  groundBounds,
  groundDate,
  groundTime,
  isTodoPhrase,
  namedDays,
  namedWeekdays,
  periodOf,
  periodTimes,
  statedTimes,
  statesDuration,
  windowOf,
} from './grounding.ts';

// 2026-08-22 is a Saturday.
const REFERENCE = '2026-08-22';

describe('statedTimes', () => {
  it('reads the clock times a phrase states, in either language', () => {
    expect(statedTimes('Lunch at 1')).toEqual({ start: { exact: false, hour: 1, minute: 0 } });
    expect(statedTimes('Lunch at 1pm').start).toEqual({ exact: true, hour: 13, minute: 0 });
    expect(statedTimes('Call at 7 a.m.').start).toEqual({ exact: true, hour: 7, minute: 0 });
    expect(statedTimes('Standup 09:00').start).toEqual({ exact: false, hour: 9, minute: 0 });
    expect(statedTimes('Dinner 19:30').start).toEqual({ exact: true, hour: 19, minute: 30 });
    expect(statedTimes('Zahnarzt um 14.30 Uhr').start).toEqual({
      exact: true,
      hour: 14,
      minute: 30,
    });
    expect(statedTimes('Treffen um 8 Uhr').start).toEqual({ exact: false, hour: 8, minute: 0 });
    expect(statedTimes('Treffen um ein Uhr').start).toEqual({ exact: false, hour: 1, minute: 0 });
    expect(statedTimes('meet @7').start).toEqual({ exact: false, hour: 7, minute: 0 });
    expect(statedTimes('call at three').start).toEqual({ exact: false, hour: 3, minute: 0 });
    expect(statedTimes('Zahnarzt um halb drei').start).toEqual({
      exact: false,
      hour: 2,
      minute: 30,
    });
    expect(statedTimes('tea at half past two').start).toEqual({
      exact: false,
      hour: 2,
      minute: 30,
    });
    expect(statedTimes('a quarter to three').start).toEqual({ exact: false, hour: 2, minute: 45 });
    expect(statedTimes('viertel nach drei').start).toEqual({ exact: false, hour: 3, minute: 15 });
    expect(statedTimes("tee at five o'clock").start).toEqual({ exact: false, hour: 5, minute: 0 });
    expect(statedTimes('lunch at noon').start).toEqual({ exact: true, hour: 12, minute: 0 });
    expect(statedTimes('party until midnight').start).toBeUndefined();
    expect(statedTimes('Mitternachtsmesse um Mitternacht').start).toEqual({
      exact: true,
      hour: 0,
      minute: 0,
    });
  });

  it('reads a range as a start and an end', () => {
    expect(statedTimes('Workshop 2-4pm')).toEqual({
      end: { exact: true, hour: 16, minute: 0 },
      start: { exact: true, hour: 14, minute: 0 },
    });
    expect(statedTimes('Standup 9-9:30')).toEqual({
      end: { exact: false, hour: 9, minute: 30 },
      start: { exact: false, hour: 9, minute: 0 },
    });
    expect(statedTimes('Standup | +0 | 09:00-09:30 | Room 4')).toEqual({
      end: { exact: false, hour: 9, minute: 30 },
      start: { exact: false, hour: 9, minute: 0 },
    });
    expect(statedTimes('from 2 to 4')).toEqual({
      end: { exact: false, hour: 4, minute: 0 },
      start: { exact: false, hour: 2, minute: 0 },
    });
    expect(statedTimes('von 14 bis 16 Uhr')).toEqual({
      end: { exact: true, hour: 16, minute: 0 },
      start: { exact: true, hour: 14, minute: 0 },
    });
    expect(statedTimes('between 9 and 11')).toEqual({
      end: { exact: false, hour: 11, minute: 0 },
      start: { exact: false, hour: 9, minute: 0 },
    });
    expect(statedTimes('Meeting at 3 until 5pm')).toEqual({
      end: { exact: true, hour: 17, minute: 0 },
      start: { exact: false, hour: 3, minute: 0 },
    });
  });

  it('does not mistake dates, years, durations or German "am" for times', () => {
    expect(statedTimes('Treffen am 17.10.')).toEqual({});
    expect(statedTimes('Offsite Oct 20')).toEqual({});
    expect(statedTimes('Dates 17-18 Oct')).toEqual({});
    expect(statedTimes('Retro in 2026')).toEqual({});
    expect(statedTimes('Workshop 2h tomorrow')).toEqual({});
    expect(statedTimes('Treffen um 7 am Montag').start).toEqual({
      exact: false,
      hour: 7,
      minute: 0,
    });
    expect(statedTimes('7 amazing things')).toEqual({});
    expect(statedTimes('Dentist | +3 | 14:30').start).toEqual({
      exact: true,
      hour: 14,
      minute: 30,
    });
    expect(statedTimes('Call with Anna tomorrow')).toEqual({});
  });

  it('prefers the exact reading of the same words', () => {
    expect(statedTimes('Dinner at 7pm').start).toEqual({ exact: true, hour: 19, minute: 0 });
    expect(statedTimes('Dinner at 7:30pm').start).toEqual({ exact: true, hour: 19, minute: 30 });
  });
});

describe('periodOf', () => {
  it('names the meal or part of the day, meals first', () => {
    expect(periodOf('Dinner with Teo')).toBe('dinner');
    expect(periodOf('dinner tonight')).toBe('dinner');
    expect(periodOf('Abendessen mit Teo')).toBe('dinner');
    expect(periodOf('heute abend Kino')).toBe('evening');
    expect(periodOf('Mittagessen')).toBe('lunch');
    expect(periodOf('Frühstück mit Anna')).toBe('breakfast');
    expect(periodOf('lunchtime run')).toBe('lunch');
    expect(periodOf('drinks after work')).toBe('evening');
    expect(periodOf('Standup every weekday morning')).toBe('morning');
    expect(periodOf('movie night')).toBe('night');
    expect(periodOf('Call with Anna')).toBeUndefined();
    // German "morgen" is tomorrow as often as morning.
    expect(periodOf('Zahnarzt morgen')).toBeUndefined();
  });

  it('shares the finder presets for the parts of the day', () => {
    for (const [period, preset] of [
      ['morning', 'mornings'],
      ['afternoon', 'afternoons'],
      ['evening', 'evenings'],
    ] as const) {
      const { earliestTime, latestTime } = periodTimes(period);
      expect(FINDER_BOUNDS.find((option) => option.value === preset)?.times).toEqual({
        earliestTime,
        latestTime,
      });
    }
  });
});

describe('groundTime', () => {
  it('keeps the model time a stated time allows, in either half of the day', () => {
    expect(groundTime('13:00', 'Lunch at 1')).toEqual({ source: 'stated', startTime: '13:00' });
    expect(groundTime('21:00', 'Drinks at 9')).toEqual({ source: 'stated', startTime: '21:00' });
    expect(groundTime('14:30', 'Zahnarzt um halb drei')).toEqual({
      source: 'stated',
      startTime: '14:30',
    });
  });

  it('corrects a model time the phrase contradicts', () => {
    // Observed: "at 8" with dinner came back as 18:00.
    expect(groundTime('18:00', 'Dinner with Teo at 8')).toEqual({
      source: 'stated',
      startTime: '20:00',
    });
    expect(groundTime('20:00', 'Breakfast at 8')).toEqual({ source: 'stated', startTime: '08:00' });
    expect(groundTime('13:15', 'Lunch at 1')).toEqual({ source: 'stated', startTime: '13:00' });
    expect(groundTime('03:00', 'Call at 1pm')).toEqual({ source: 'stated', startTime: '13:00' });
  });

  it('fills a stated time the model left out', () => {
    expect(groundTime(undefined, 'Lunch at 1')).toEqual({ source: 'stated', startTime: '13:00' });
    expect(groundTime(undefined, 'Call at 9')).toEqual({ source: 'stated', startTime: '09:00' });
    expect(groundTime(undefined, 'Call at 12')).toEqual({ source: 'stated', startTime: '12:00' });
    expect(groundTime(undefined, 'Call at 11 tonight')).toEqual({
      source: 'stated',
      startTime: '23:00',
    });
  });

  it('takes the end from a stated range only', () => {
    expect(groundTime('14:00', 'Workshop 2-4pm')).toEqual({
      endTime: '16:00',
      source: 'stated',
      startTime: '14:00',
    });
    expect(groundTime('09:00', 'Standup 9-9:30')).toEqual({
      endTime: '09:30',
      source: 'stated',
      startTime: '09:00',
    });
    expect(groundTime('09:00', 'from 9 to 5')).toEqual({
      endTime: '17:00',
      source: 'stated',
      startTime: '09:00',
    });
    // An end before the start in every reading is no end.
    expect(groundTime('14:00', 'Workshop at 2pm to 1pm')).toEqual({
      source: 'stated',
      startTime: '14:00',
    });
  });

  it('puts a named meal or part of the day at its default, whatever the model said', () => {
    expect(groundTime('13:00', 'Dinner with Teo next Friday')).toEqual({
      source: 'period',
      startTime: '19:00',
    });
    expect(groundTime(undefined, 'Breakfast meeting Monday')).toEqual({
      source: 'period',
      startTime: '08:00',
    });
    expect(groundTime('00:00', 'Kino heute abend')).toEqual({
      source: 'period',
      startTime: '18:00',
    });
  });

  it('drops a time the phrase never stated', () => {
    expect(groundTime('13:00', 'Call with Anna tomorrow')).toEqual({ source: 'none' });
    expect(groundTime('00:00', 'Team offsite Oct 20')).toEqual({ source: 'none' });
  });
});

const ground = (modelDate: string | undefined, phrase: string) =>
  groundDate(modelDate, { phrase, referenceDate: REFERENCE });

describe('groundDate', () => {
  it('reads today and tomorrow itself', () => {
    expect(ground('2026-08-30', 'Call tomorrow')).toBe('2026-08-23');
    expect(ground(undefined, 'Call today')).toBe('2026-08-22');
    expect(ground(undefined, 'Kino heute abend')).toBe('2026-08-22');
    expect(ground(undefined, 'dinner tonight')).toBe('2026-08-22');
    expect(ground(undefined, 'the day after tomorrow')).toBe('2026-08-24');
  });

  it('lands a named weekday on that weekday, forward from the model date', () => {
    // Observed: "next Friday" came back as a Thursday, "Thursday" as a Tuesday.
    expect(ground('2026-08-27', 'Dinner with Teo next Friday')).toBe('2026-08-28');
    expect(ground('2026-08-25', 'Dentist Thursday')).toBe('2026-08-27');
    // Already right: kept, even a week later than the nearest one.
    expect(ground('2026-09-04', 'Dinner next Friday')).toBe('2026-09-04');
    // No model date: the next such day from today.
    expect(ground(undefined, 'Dentist Thursday')).toBe('2026-08-27');
    expect(ground(undefined, 'lunch tue 1pm')).toBe('2026-08-25');
    expect(ground(undefined, 'Zahnarzt Dienstag')).toBe('2026-08-25');
    // Today is that weekday: "next" means a week on, a bare name means today.
    expect(ground('2026-08-22', 'Dentist next Saturday')).toBe('2026-08-29');
    expect(ground(undefined, 'Dentist Saturday')).toBe('2026-08-22');
    // A model date in the past is not an anchor.
    expect(ground('2026-08-14', 'Dentist Friday')).toBe('2026-08-28');
  });

  it('has no opinion on dates it cannot read', () => {
    expect(ground('2026-10-20', 'Offsite Oct 20')).toBeUndefined();
    expect(ground(undefined, 'Zahnarzt morgen')).toBeUndefined();
    // Two weekdays: not one day.
    expect(ground(undefined, 'Gym Monday and Wednesday')).toBeUndefined();
    // "sat" and "sun" are words of their own.
    expect(ground(undefined, 'Fun in the sun')).toBeUndefined();
  });
});

describe('namedWeekdays and namedDays', () => {
  it('lists the weekdays named, in week order', () => {
    expect(namedWeekdays('Wednesdays and Mondays')).toEqual([1, 3]);
    expect(namedWeekdays('Standup every weekday morning')).toEqual([]);
  });

  it("reads the finder's day sets", () => {
    expect(namedDays('weekdays next week')).toEqual([1, 2, 3, 4, 5]);
    expect(namedDays('am Wochenende')).toEqual([6, 7]);
    expect(namedDays('Tuesdays and Thursdays')).toEqual([2, 4]);
    expect(namedDays('dinner with Teo next week')).toBeUndefined();
  });
});

describe('isTodoPhrase', () => {
  it("needs one of the prompt's cues", () => {
    expect(isTodoPhrase('remind me to call the bank')).toBe(true);
    expect(isTodoPhrase('todo: buy milk')).toBe(true);
    expect(isTodoPhrase('Don’t forget the keys')).toBe(true);
    expect(isTodoPhrase('I need to renew my passport')).toBe(true);
    expect(isTodoPhrase('Ich muss die Bank anrufen')).toBe(true);
    expect(isTodoPhrase('Nicht vergessen: Milch')).toBe(true);
    // Observed: the model called every one of these a task.
    expect(isTodoPhrase('Lunch with Sarah tomorrow at 1')).toBe(false);
    expect(isTodoPhrase('Dentist Thursday')).toBe(false);
    expect(isTodoPhrase('Call with Anna tomorrow')).toBe(false);
  });
});

describe('statesDuration', () => {
  it('spots how long in either language', () => {
    expect(statesDuration('90 min focus')).toBe(true);
    expect(statesDuration('2h deep work')).toBe(true);
    expect(statesDuration('an hour tomorrow')).toBe(true);
    expect(statesDuration('half an hour with Anna')).toBe(true);
    expect(statesDuration('eineinhalb Stunden')).toBe(true);
    expect(statesDuration('1.5 hours')).toBe(true);
    expect(statesDuration('dinner with Teo next week')).toBe(false);
  });
});

describe('windowOf', () => {
  it('reads a window named in words, from the reference date', () => {
    expect(windowOf('dinner tomorrow', REFERENCE)).toEqual({
      windowEndDate: '2026-08-23',
      windowStartDate: '2026-08-23',
    });
    expect(windowOf('today', REFERENCE)).toEqual({
      windowEndDate: '2026-08-22',
      windowStartDate: '2026-08-22',
    });
    // A Saturday: this week ends tomorrow, next week is Monday to Sunday.
    expect(windowOf('this week', REFERENCE)).toEqual({
      windowEndDate: '2026-08-23',
      windowStartDate: '2026-08-22',
    });
    expect(windowOf('dinner with Teo next week', REFERENCE)).toEqual({
      windowEndDate: '2026-08-30',
      windowStartDate: '2026-08-24',
    });
    expect(windowOf('nächste Woche', REFERENCE)).toEqual({
      windowEndDate: '2026-08-30',
      windowStartDate: '2026-08-24',
    });
    expect(windowOf('in the next two weeks', REFERENCE)).toEqual({
      windowEndDate: '2026-09-04',
      windowStartDate: '2026-08-22',
    });
    expect(windowOf('focus', REFERENCE)).toBeUndefined();
    expect(windowOf('on Oct 20', REFERENCE)).toBeUndefined();
  });
});

describe('groundBounds', () => {
  it('keeps the model bounds only beside a stated clock time', () => {
    expect(groundBounds({ earliestTime: '17:00' }, 'after 5pm')).toEqual({ earliestTime: '17:00' });
    expect(
      groundBounds({ earliestTime: '12:00', latestTime: '17:00' }, 'dinner next week'),
    ).toEqual({ earliestTime: '18:00', latestTime: '21:00' });
    expect(groundBounds({ earliestTime: '08:00', latestTime: '12:00' }, 'mornings')).toEqual({
      earliestTime: '08:00',
      latestTime: '12:00',
    });
    expect(groundBounds({ earliestTime: '08:00', latestTime: '12:00' }, '90 min focus')).toEqual(
      {},
    );
  });
});
