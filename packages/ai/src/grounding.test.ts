import { FINDER_BOUNDS } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import {
  defersDate,
  durationMinutesOf,
  groundBounds,
  groundDate,
  groundDays,
  mentionsDate,
  namedWeekdays,
  periodOf,
  periodTimes,
  windowOf,
} from './grounding.ts';

// 2026-08-22 is a Saturday.
const REFERENCE = '2026-08-22';

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
    // A weekday ruled out is no day to land on; one after another kind of
    // "not" or "ohne" still is.
    expect(ground('2026-08-24', 'Standup jeden Werktag um 9 außer Freitag')).toBeUndefined();
    expect(ground(undefined, 'not on Tuesday')).toBeUndefined();
    expect(ground(undefined, 'Yoga Monday but not Friday')).toBe('2026-08-24');
    expect(ground('2026-08-27', 'Abendessen ohne Kinder am Freitag')).toBe('2026-08-28');
    expect(ground('2026-08-27', 'Lunch with Tom but not Anna on Friday at 1')).toBe('2026-08-28');
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
