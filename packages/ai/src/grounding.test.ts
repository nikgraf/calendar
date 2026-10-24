import { FINDER_BOUNDS } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import {
  clearsRepeat,
  defersDate,
  durationMinutesOf,
  groundBounds,
  groundDate,
  groundDays,
  groundTime,
  groundTitle,
  isAllDayPhrase,
  isTodoPhrase,
  mentionsDate,
  mentionsRepeat,
  namedWeekdays,
  periodOf,
  periodTimes,
  statedTimes,
  statesClockTime,
  statesDuration,
  trimWhen,
  windowOf,
  withoutPlace,
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

  it('gives the end its unit without pushing the start past it', () => {
    // Review: "from 9 to 5pm" read as 21:00–, and "11-1pm" as 23:00–.
    expect(statedTimes('Workshop from 9 to 5pm')).toEqual({
      end: { exact: true, hour: 17, minute: 0 },
      start: { exact: false, hour: 9, minute: 0 },
    });
    expect(statedTimes('Lunch 11-1pm')).toEqual({
      end: { exact: true, hour: 13, minute: 0 },
      start: { exact: false, hour: 11, minute: 0 },
    });
    expect(statedTimes('from 12 to 2pm')).toEqual({
      end: { exact: true, hour: 14, minute: 0 },
      start: { exact: true, hour: 12, minute: 0 },
    });
    expect(statedTimes('9am-5pm')).toEqual({
      end: { exact: true, hour: 17, minute: 0 },
      start: { exact: true, hour: 9, minute: 0 },
    });
  });

  it('reads a compound time with its unit, and not its fragments', () => {
    // Review: "two pm" inside "half past two pm" outranked the compound.
    expect(statedTimes('Call at half past two pm').start).toEqual({
      exact: true,
      hour: 14,
      minute: 30,
    });
    expect(statedTimes('um halb drei uhr').start).toEqual({ exact: false, hour: 2, minute: 30 });
    // Review: the dotted a.m. ends in punctuation, which a word boundary cannot follow.
    expect(statedTimes('Call at half past seven a.m.').start).toEqual({
      exact: true,
      hour: 7,
      minute: 30,
    });
    // Review: "to three" inside "quarter to three" is not an end.
    expect(statedTimes('Call at quarter to three')).toEqual({
      start: { exact: false, hour: 2, minute: 45 },
    });
    expect(statedTimes('Call at quarter to three until four')).toEqual({
      end: { exact: false, hour: 4, minute: 0 },
      start: { exact: false, hour: 2, minute: 45 },
    });
  });

  it('knows a bare closer is a written time', () => {
    expect(statesClockTime('30 min focus until 5pm')).toBe(true);
    expect(statesClockTime('Fokus bis 17 Uhr')).toBe(true);
    expect(statesClockTime('90 min focus')).toBe(false);
    // Review: "before 10" and "after 5" are written times too.
    expect(statesClockTime('Find an hour before 10')).toBe(true);
    expect(statesClockTime('Find an hour after 5')).toBe(true);
    expect(statedTimes('Call after 5').start).toEqual({ exact: false, hour: 5, minute: 0 });
    expect(statedTimes('Call before 10')).toEqual({});
    // A number before a length of time is a duration, not a clock.
    expect(statesClockTime('Follow-up nach 2 Tagen')).toBe(false);
    expect(statesClockTime('um 5 Minuten verschieben')).toBe(false);
  });

  it('takes noon and midnight as range ends', () => {
    // Review: "from 8 to noon" lost its start.
    expect(statedTimes('Workshop from 8 to noon')).toEqual({
      end: { exact: true, hour: 12, minute: 0 },
      start: { exact: false, hour: 8, minute: 0 },
    });
    expect(statedTimes('open until midnight')).toEqual({});
    expect(statedTimes('from noon to 2')).toEqual({
      end: { exact: false, hour: 2, minute: 0 },
      start: { exact: true, hour: 12, minute: 0 },
    });
  });

  it('resolves the hour before subtracting a quarter or a half', () => {
    // Review: "quarter to twelve pm" came out as 23:45.
    expect(statedTimes('Call at quarter to twelve pm').start).toEqual({
      exact: true,
      hour: 11,
      minute: 45,
    });
    expect(statedTimes('quarter to twelve am').start).toEqual({
      exact: true,
      hour: 23,
      minute: 45,
    });
    expect(statedTimes('quarter to one').start).toEqual({ exact: false, hour: 0, minute: 45 });
    expect(statedTimes('halb eins').start).toEqual({ exact: false, hour: 0, minute: 30 });
  });

  it('does not mistake dates, years, durations or German "am" for times', () => {
    expect(statedTimes('Treffen am 17.10.')).toEqual({});
    // Review: a span of dates is not a span of hours.
    expect(statedTimes('Vacation from 17 to 18 October')).toEqual({});
    expect(statesClockTime('Urlaub bis 17. Oktober')).toBe(false);
    expect(statesClockTime('Offsite after 20 Oct')).toBe(false);
    expect(statedTimes('from 17 to 18 Uhr')).toEqual({
      end: { exact: true, hour: 18, minute: 0 },
      start: { exact: true, hour: 17, minute: 0 },
    });
    expect(statedTimes('Offsite Oct 20')).toEqual({});
    expect(statedTimes('Dates 17-18 Oct')).toEqual({});
    expect(statedTimes('Retro in 2026')).toEqual({});
    expect(statedTimes('Workshop 2h tomorrow')).toEqual({});
    // Review: "pm" is never German, so a date right after it is no reason to drop it.
    expect(statedTimes('Call 3pm 20 Oct').start).toEqual({ exact: true, hour: 15, minute: 0 });
    expect(statedTimes('Treffen um 7 am 17.')).toEqual({
      start: { exact: false, hour: 7, minute: 0 },
    });
    // Review: "ein" is a number only before "Uhr".
    expect(statedTimes('kümmere mich um ein paar Dinge')).toEqual({});
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
    expect(groundTime('09:00', 'Workshop from 9 to 5pm')).toEqual({
      endTime: '17:00',
      source: 'stated',
      startTime: '09:00',
    });
    expect(groundTime('11:00', 'Lunch 11-1pm')).toEqual({
      endTime: '13:00',
      source: 'stated',
      startTime: '11:00',
    });
    expect(groundTime('14:30', 'Call at half past two pm')).toEqual({
      source: 'stated',
      startTime: '14:30',
    });
    expect(groundTime('14:45', 'Call at quarter to three')).toEqual({
      source: 'stated',
      startTime: '14:45',
    });
    expect(groundTime('08:00', 'Workshop from 8 to noon')).toEqual({
      endTime: '12:00',
      source: 'stated',
      startTime: '08:00',
    });
    // An open "quarter to one" reads as 12:45, not 00:45.
    expect(groundTime(undefined, 'Call at quarter to one')).toEqual({
      source: 'stated',
      startTime: '12:45',
    });
    expect(groundTime('12:30', 'Treffen um halb eins')).toEqual({
      source: 'stated',
      startTime: '12:30',
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

  it('leaves a meal used as a boundary, or ruled out, to the model', () => {
    // Review: "before lunch" was read as lunch itself, "not in the morning" as the morning.
    expect(groundTime('14:00', 'Call tomorrow, not in the morning')).toEqual({
      source: 'model',
      startTime: '14:00',
    });
    expect(groundTime('11:00', 'Call before lunch')).toEqual({
      source: 'model',
      startTime: '11:00',
    });
    expect(groundTime(undefined, 'Call after dinner')).toEqual({ source: 'model' });
    expect(groundTime('13:30', 'Anruf nach dem Mittagessen')).toEqual({
      source: 'model',
      startTime: '13:30',
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
    // Review: a day word as the anchor of an offset, a weekday that has passed.
    expect(ground('2026-09-05', 'Call two weeks from today')).toBeUndefined();
    expect(ground('2026-08-30', 'Call a week from tomorrow')).toBeUndefined();
    expect(ground('2026-08-21', 'Dentist last Friday at 9am')).toBeUndefined();
    expect(ground('2026-08-21', 'Zahnarzt letzten Freitag')).toBeUndefined();
    expect(ground(undefined, 'Call yesterday')).toBe('2026-08-21');
    // Review: a weekday as the anchor of an offset or a boundary.
    expect(ground('2026-08-26', 'Call two days after Monday')).toBeUndefined();
    expect(ground('2026-08-27', 'Call before Friday')).toBeUndefined();
    expect(ground(undefined, 'Zahnarzt morgen')).toBeUndefined();
    // Two weekdays: not one day.
    expect(ground(undefined, 'Gym Monday and Wednesday')).toBeUndefined();
    // "sat" and "sun" are words of their own.
    expect(ground(undefined, 'Fun in the sun')).toBeUndefined();
  });
});

describe('namedWeekdays and groundDays', () => {
  it('lists the weekdays named, in week order', () => {
    expect(namedWeekdays('Wednesdays and Mondays')).toEqual([1, 3]);
    expect(namedWeekdays('Standup every weekday morning')).toEqual([]);
  });

  it("reads the finder's day sets", () => {
    expect(groundDays([2], 'weekdays next week')).toEqual([1, 2, 3, 4, 5]);
    expect(groundDays([2], 'am Wochenende')).toEqual([6, 7]);
    expect(groundDays([2], 'Tuesdays and Thursdays')).toEqual([2, 4]);
    expect(groundDays([2], 'dinner with Teo next week')).toBeUndefined();
  });

  it('expands a range of weekdays, with any day named beside it', () => {
    // Review: "Monday through Friday" came out as [1, 5], and a day beside the range was dropped.
    expect(groundDays([2], 'Monday through Friday')).toEqual([1, 2, 3, 4, 5]);
    expect(groundDays(undefined, 'Freitag bis Montag')).toEqual([1, 5, 6, 7]);
    expect(groundDays(undefined, 'Tue-Thu mornings')).toEqual([2, 3, 4]);
    expect(groundDays(undefined, 'Monday through Friday and Sunday')).toEqual([1, 2, 3, 4, 5, 7]);
    // Review: a set word beside named days.
    expect(groundDays(undefined, 'weekdays and Saturdays')).toEqual([1, 2, 3, 4, 5, 6]);
    expect(groundDays(undefined, 'Mondays and weekends')).toEqual([1, 6, 7]);
  });

  it('leaves an exclusion to the model', () => {
    // Review: "any day except Tuesday" came out as exactly Tuesday — and so
    // did "but Tuesday", "not on Tuesday" and "außer Dienstag".
    const model = [1, 3, 4, 5, 6, 7];
    expect(groundDays(model, 'an hour any day except Tuesday')).toEqual(model);
    expect(groundDays(model, 'any day but Tuesday')).toEqual(model);
    expect(groundDays(model, 'not on Tuesday')).toEqual(model);
    expect(groundDays(model, 'jeden Tag außer Dienstag')).toEqual(model);
    expect(groundDays(model, 'nicht am Dienstag')).toEqual(model);
    expect(groundDays(undefined, 'jeden Tag ausser Dienstag')).toBeUndefined();
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

describe('durationMinutesOf', () => {
  it('reads the length in minutes', () => {
    expect(durationMinutesOf('90 min focus')).toBe(90);
    expect(durationMinutesOf('2h deep work')).toBe(120);
    expect(durationMinutesOf('an hour tomorrow')).toBe(60);
    expect(durationMinutesOf('half an hour with Anna')).toBe(30);
    expect(durationMinutesOf('eineinhalb Stunden')).toBe(90);
    expect(durationMinutesOf('1.5 hours')).toBe(90);
    expect(durationMinutesOf('two hours of focus')).toBe(120);
    expect(durationMinutesOf('thirty minutes this week')).toBe(30);
    expect(durationMinutesOf('forty-five minutes')).toBe(45);
    expect(durationMinutesOf('90-minute workshop')).toBe(90);
    expect(durationMinutesOf('dinner with Teo next week')).toBeUndefined();
    // Review: a half on top of the hours.
    expect(durationMinutesOf('an hour and a half of focus')).toBe(90);
    expect(durationMinutesOf('two and a half hours')).toBe(150);
    expect(durationMinutesOf('zweieinhalb Stunden')).toBe(150);
    // Review: tens and ones are one number, in either language.
    expect(durationMinutesOf('twenty-five minutes')).toBe(25);
    expect(durationMinutesOf('twenty five minutes')).toBe(25);
    expect(durationMinutesOf('fünfundzwanzig Minuten')).toBe(25);
    // Review: the parts of one length add up; a second length is another matter.
    expect(durationMinutesOf('1 hour 30 minutes of focus')).toBe(90);
    expect(durationMinutesOf('2h and 15 min')).toBe(135);
    expect(durationMinutesOf('eine Stunde und 30 Minuten')).toBe(90);
    expect(durationMinutesOf('30 min focus, then 2h deep work')).toBe(30);
  });
});

describe('the words of a change', () => {
  it('reads all day, a repeat and its removal', () => {
    expect(isAllDayPhrase('make it all day')).toBe(true);
    expect(isAllDayPhrase('ganztägig')).toBe(true);
    expect(isAllDayPhrase('at 8')).toBe(false);
    expect(mentionsRepeat('every week')).toBe(true);
    expect(mentionsRepeat('wöchentlich')).toBe(true);
    expect(mentionsRepeat('at 8')).toBe(false);
    expect(clearsRepeat('just once')).toBe(true);
    expect(clearsRepeat("doesn't repeat")).toBe(true);
    expect(clearsRepeat('every week')).toBe(false);
  });

  it('knows a day it leaves to the model on purpose', () => {
    expect(defersDate('Zahnarzt morgen')).toBe(true);
    expect(defersDate('two weeks from today')).toBe(true);
    expect(defersDate('two days after Monday')).toBe(true);
    expect(defersDate('last Friday')).toBe(true);
    expect(defersDate('at 8')).toBe(false);
    expect(defersDate('tomorrow')).toBe(false);
  });

  it('knows a date the model has to resolve from a bare clock digit', () => {
    expect(mentionsDate('on Oct 20')).toBe(true);
    expect(mentionsDate('am 17.10.')).toBe(true);
    expect(mentionsDate('in two weeks')).toBe(true);
    expect(mentionsDate('next month')).toBe(true);
    expect(mentionsDate('at 8')).toBe(false);
    expect(mentionsDate('call it team dinner')).toBe(false);
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
    // Review: written and hyphenated durations.
    expect(statesDuration('two hours of focus')).toBe(true);
    expect(statesDuration('zwei Stunden')).toBe(true);
    expect(statesDuration('eine Stunde')).toBe(true);
    expect(statesDuration('90-minute workshop')).toBe(true);
    // Review: lengths written in words beyond twelve.
    expect(statesDuration('thirty minutes this week')).toBe(true);
    expect(statesDuration('ninety minutes')).toBe(true);
    expect(statesDuration('dreissig Minuten')).toBe(true);
    expect(statesDuration('dinner with Teo next week')).toBe(false);
    expect(statesDuration('a hike on Sunday')).toBe(false);
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
    expect(windowOf('the day after tomorrow', REFERENCE)).toEqual({
      windowEndDate: '2026-08-24',
      windowStartDate: '2026-08-24',
    });
  });

  it('leaves what it cannot read to the model', () => {
    // Review: "in two weeks" is an offset, not a span.
    expect(windowOf('Find an hour in two weeks', REFERENCE)).toBeUndefined();
    expect(windowOf('in zwei Wochen', REFERENCE)).toBeUndefined();
    // Review: "tomorrow" as one end of a span, or beside another day word.
    expect(windowOf('an hour between today and tomorrow', REFERENCE)).toBeUndefined();
    expect(windowOf('starting tomorrow for two weeks', REFERENCE)).toBeUndefined();
    expect(windowOf('ab morgen', REFERENCE)).toBeUndefined();
    // Review: a span whose other end the code cannot read, an offset from today.
    expect(windowOf('Find an hour between tomorrow and August 28', REFERENCE)).toBeUndefined();
    expect(windowOf('from tomorrow to Friday', REFERENCE)).toBeUndefined();
    expect(windowOf('a week from today', REFERENCE)).toBeUndefined();
    // Review: a week word as the end of a span.
    expect(windowOf('Find an hour before next week', REFERENCE)).toBeUndefined();
    expect(windowOf('starting next week for two weeks', REFERENCE)).toBeUndefined();
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
    // Review: a bare closer is a written time too.
    expect(groundBounds({ latestTime: '17:00' }, '30 min focus until 5pm')).toEqual({
      latestTime: '17:00',
    });
    expect(groundBounds({ latestTime: '10:00' }, 'Find an hour before 10')).toEqual({
      latestTime: '10:00',
    });
    expect(groundBounds({ earliestTime: '17:00' }, 'Find an hour after 5')).toEqual({
      earliestTime: '17:00',
    });
    // Review: a meal as a boundary is not the meal's window.
    expect(groundBounds({ latestTime: '11:30' }, 'Find an hour before lunch next week')).toEqual({
      latestTime: '11:30',
    });
    expect(groundBounds({ earliestTime: '20:00' }, 'after dinner')).toEqual({
      earliestTime: '20:00',
    });
    // Review: a period ruled out is not the window either.
    expect(
      groundBounds(
        { earliestTime: '12:00', latestTime: '20:00' },
        'Find an hour next week, not in the morning',
      ),
    ).toEqual({ earliestTime: '12:00', latestTime: '20:00' });
  });
});

describe('groundTitle', () => {
  it("keeps a title made of the phrase's words", () => {
    expect(groundTitle('Lunch with Sarah', 'lunch with Sarah tue 1pm at Figlmüller')).toBe(
      'Lunch with Sarah',
    );
    expect(groundTitle('Call the bank', 'remind me to call the bank tomorrow')).toBe(
      'Call the bank',
    );
    expect(groundTitle('Zahnarzt', 'Zahnarzt nächsten Dienstag um halb drei')).toBe('Zahnarzt');
    expect(groundTitle("Tom's birthday", "tom's birthday saturday")).toBe("Tom's birthday");
  });

  it('takes the phrase when the title names words it never said', () => {
    // Observed on device: the prompt's example title, copied.
    expect(groundTitle('Lunch with Sarah', 'lunch with tom tomorrow ')).toBe(
      'lunch with tom tomorrow',
    );
    expect(groundTitle('Dinner with Sarah', 'dinner with tom tomorrow')).toBe(
      'dinner with tom tomorrow',
    );
    expect(groundTitle('Call the bank', 'remind me to call mom')).toBe('remind me to call mom');
    // A name mangled by the model is not the one typed.
    expect(groundTitle('Lunch with Järg', 'Lunch with Jörg')).toBe('Lunch with Jörg');
  });

  it('lets a model add words that name no one', () => {
    expect(groundTitle('Lunch with Tom', 'Lunch w/ Tom at Figlmüller tomorrow at 1')).toBe(
      'Lunch with Tom',
    );
    expect(groundTitle('Dentist appointment', 'dentist tomorrow 9')).toBe('Dentist appointment');
    expect(groundTitle('Meeting', 'tomorrow at 9')).toBe('Meeting');
  });

  it('takes the phrase when the title is nothing but when', () => {
    // Observed: "tomorrow" for the title, "tom" for the place.
    expect(groundTitle('tomorrow', 'dinner with tom tomorrow')).toBe('dinner with tom tomorrow');
    expect(groundTitle('next Tuesday at 1pm', 'Lunch next Tuesday at 1pm')).toBe(
      'Lunch next Tuesday at 1pm',
    );
  });
});

describe('trimWhen', () => {
  it('takes the words about when off the end', () => {
    expect(trimWhen('lunch with tom tomorrow')).toBe('lunch with tom');
    expect(trimWhen('Lunch with Sam tomorrow at 12:30')).toBe('Lunch with Sam');
    expect(trimWhen('coffee with max next tuesday at 3')).toBe('coffee with max');
    expect(trimWhen('dinner with anna friday')).toBe('dinner with anna');
    expect(trimWhen('Team standup every monday at 9')).toBe('Team standup');
    expect(trimWhen('Standup every weekday at 9:30')).toBe('Standup');
    expect(trimWhen('Sync weekly')).toBe('Sync');
    expect(trimWhen('Workshop 2-4pm tomorrow')).toBe('Workshop');
    expect(trimWhen('Dentist 9am tomorrow')).toBe('Dentist');
    expect(trimWhen('Conference Sep 1')).toBe('Conference');
    expect(trimWhen('Conference on the 3rd of October')).toBe('Conference');
    expect(trimWhen('Run tomorrow morning')).toBe('Run');
    expect(trimWhen('Party on Friday night')).toBe('Party');
    expect(trimWhen('Offsite all day')).toBe('Offsite');
    expect(trimWhen('Lunch with Tom, tomorrow')).toBe('Lunch with Tom');
    expect(trimWhen('Dinner at noon')).toBe('Dinner');
    expect(trimWhen('Drinks at eight')).toBe('Drinks');
  });

  it('reads German the same way', () => {
    expect(trimWhen('Mittagessen mit Tom morgen')).toBe('Mittagessen mit Tom');
    expect(trimWhen('Zahnarzt Dienstag um 10')).toBe('Zahnarzt');
    expect(trimWhen('Zahnarzt nächsten Dienstag um halb drei')).toBe('Zahnarzt');
    expect(trimWhen('Treffen am Montag Abend')).toBe('Treffen');
    expect(trimWhen('Training jeden Mittwoch 18 Uhr')).toBe('Training');
    expect(trimWhen('Jour fixe wöchentlich')).toBe('Jour fixe');
    expect(trimWhen('Essen übermorgen')).toBe('Essen');
    expect(trimWhen('Konferenz 17.10.')).toBe('Konferenz');
  });

  it('takes a day said first, but not a weekday', () => {
    expect(trimWhen('tomorrow lunch with tom')).toBe('lunch with tom');
    expect(trimWhen('Tomorrow: lunch with Tom at 1')).toBe('lunch with Tom');
    expect(trimWhen('Monday standup')).toBe('Monday standup');
    expect(trimWhen('Sunday brunch tomorrow')).toBe('Sunday brunch');
  });

  it('leaves the middle, bare numbers and a title that is only when', () => {
    expect(trimWhen('lunch tomorrow with tom')).toBe('lunch tomorrow with tom');
    expect(trimWhen('Room 9')).toBe('Room 9');
    expect(trimWhen('Room 9 at 10')).toBe('Room 9');
    expect(trimWhen('Lunch with Sam tomorrow at 12:30 at Mercato')).toBe(
      'Lunch with Sam tomorrow at 12:30 at Mercato',
    );
    expect(trimWhen('Planning 2027')).toBe('Planning 2027');
    expect(trimWhen('tomorrow')).toBe('tomorrow');
    expect(trimWhen('tomorrow at 9')).toBe('tomorrow at 9');
    expect(trimWhen('Lunch')).toBe('Lunch');
  });

  it('leaves a day a span, a bound or company holds', () => {
    // Review: only the day came off, the word before it hung on.
    expect(trimWhen('Vacation until Friday')).toBe('Vacation until Friday');
    expect(trimWhen('Out of office until Monday')).toBe('Out of office until Monday');
    expect(trimWhen('Urlaub bis Montag')).toBe('Urlaub bis Montag');
    expect(trimWhen('Trip from Monday to Friday')).toBe('Trip from Monday to Friday');
    expect(trimWhen('Conference through Friday')).toBe('Conference through Friday');
    expect(trimWhen('Open until 5pm')).toBe('Open until 5pm');
    expect(trimWhen('Call before 10')).toBe('Call before 10');
    expect(trimWhen('Lunch with Thu')).toBe('Lunch with Thu');
    expect(trimWhen('Coffee with Tue tomorrow')).toBe('Coffee with Tue');
    expect(trimWhen('Call with Jan 15')).toBe('Call with Jan 15');
    expect(trimWhen('Gym Mon and Wed')).toBe('Gym Mon and Wed');
  });

  it('leaves a day that is part of a name', () => {
    expect(trimWhen('Black Friday')).toBe('Black Friday');
    expect(trimWhen('Easter Sunday')).toBe('Easter Sunday');
    expect(trimWhen('Cyber Monday')).toBe('Cyber Monday');
    expect(trimWhen('Super Bowl Sunday')).toBe('Super Bowl Sunday');
    expect(trimWhen('Taco Tuesday')).toBe('Taco Tuesday');
    expect(trimWhen('taco tuesday every week')).toBe('taco tuesday');
    expect(trimWhen('Guten Morgen')).toBe('Guten Morgen');
  });

  it('keeps the word before a day, and takes the one that leads into a time', () => {
    expect(trimWhen('Drop by tomorrow')).toBe('Drop by');
    expect(trimWhen('Finish this tomorrow')).toBe('Finish this');
    expect(trimWhen('Carry on tomorrow')).toBe('Carry on');
    // German "ab" is "from": a span, so the day stays (and so does Ab's name).
    expect(trimWhen('Urlaub ab morgen')).toBe('Urlaub ab morgen');
    expect(trimWhen('Lunch with Ab tomorrow')).toBe('Lunch with Ab tomorrow');
    expect(trimWhen('Zahnarzt um viertel nach zehn')).toBe('Zahnarzt');
  });

  it('takes a time after a day said first, marks and quotes around a when', () => {
    expect(trimWhen('tomorrow at 1 lunch w/ tom')).toBe('lunch w/ tom');
    expect(trimWhen('Tomorrow morning: run')).toBe('run');
    expect(trimWhen('Lunch (3pm)')).toBe('Lunch');
    expect(trimWhen('Lunch “tomorrow”')).toBe('Lunch');
    expect(trimWhen('At five guys')).toBe('At five guys');
  });

  it('keeps the original spelling of what is left', () => {
    expect(trimWhen('Grüße an Jörg morgen')).toBe('Grüße an Jörg');
    expect(trimWhen('Straße fegen heute')).toBe('Straße fegen');
  });
});

describe('withoutPlace', () => {
  it('takes the place and the word leading into it off the end', () => {
    expect(withoutPlace('Drinks with Jo at Loos Bar', 'Loos Bar')).toBe('Drinks with Jo');
    expect(withoutPlace('Mittagessen Figlmüller', 'Figlmüller')).toBe('Mittagessen');
    expect(withoutPlace('Meeting at the office', 'office')).toBe('Meeting');
    expect(withoutPlace('Kaffee im Café Central', 'Café Central')).toBe('Kaffee');
  });

  it('leaves a title that is only the place, or does not end with it', () => {
    expect(withoutPlace('Figlmüller', 'Figlmüller')).toBe('Figlmüller');
    expect(withoutPlace('Figlmüller dinner', 'Figlmüller')).toBe('Figlmüller dinner');
    expect(withoutPlace('Dinner', undefined)).toBe('Dinner');
  });
});
