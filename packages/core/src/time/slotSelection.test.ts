import { describe, expect, it } from 'vitest';
import { minuteOfDay, slotFromDrag, slotFromHold, slotTimes } from './slotSelection.ts';

const at = (hours: number, minutes = 0) => hours * 60 + minutes;
const times = (anchor: number, current: number) => slotTimes(slotFromDrag(anchor, current));
const hold = (anchor: number, current: number) => slotTimes(slotFromHold(anchor, current));

describe('minuteOfDay', () => {
  it('maps a column offset to minutes from midnight', () => {
    expect(minuteOfDay(48 * 10.5, 48)).toBe(at(10, 30));
  });

  it('clamps to the day', () => {
    expect(minuteOfDay(-20, 48)).toBe(0);
    expect(minuteOfDay(48 * 25, 48)).toBe(24 * 60);
  });
});

describe('slotFromDrag', () => {
  it('extends down to the next quarter at or past the pointer', () => {
    expect(times(at(10, 7), at(11, 20))).toEqual({ endTime: '11:30', startTime: '10:00' });
    // Exactly on a boundary stays there.
    expect(times(at(10, 7), at(11, 30))).toEqual({ endTime: '11:30', startTime: '10:00' });
  });

  it('extends up to the quarter at or before the pointer, keeping the anchor quarter', () => {
    expect(times(at(10, 7), at(9, 40))).toEqual({ endTime: '10:15', startTime: '09:30' });
  });

  it('is the anchor quarter while the pointer stays inside it', () => {
    expect(times(at(10, 7), at(10, 12))).toEqual({ endTime: '10:15', startTime: '10:00' });
    expect(times(at(10, 0), at(10, 0))).toEqual({ endTime: '10:15', startTime: '10:00' });
  });

  it('stays inside the day', () => {
    expect(times(at(0, 10), -30)).toEqual({ endTime: '00:15', startTime: '00:00' });
    expect(slotFromDrag(at(23, 50), at(26))).toEqual({ endMinute: 1440, startMinute: at(23, 45) });
    // An anchor at midnight itself still selects the last quarter.
    expect(slotFromDrag(1440, 1440)).toEqual({ endMinute: 1440, startMinute: at(23, 45) });
  });
});

describe('slotFromHold', () => {
  it('is one hour from the quarter the finger touched down in', () => {
    expect(hold(at(10, 7), at(10, 7))).toEqual({ endTime: '11:00', startTime: '10:00' });
  });

  it('ignores drift across a quarter line, in either direction', () => {
    // Touched down at 10:13 and drifted to 10:15.5: still the default hour.
    expect(hold(at(10, 13), at(10, 15.5))).toEqual({ endTime: '11:00', startTime: '10:00' });
    // Touched down at 10:01 and drifted up past 10:00: not 09:45.
    expect(hold(at(10, 1), at(9, 59))).toEqual({ endTime: '11:00', startTime: '10:00' });
  });

  it('never shrinks below the default hour while dragging down', () => {
    expect(hold(at(10, 7), at(10, 40))).toEqual({ endTime: '11:00', startTime: '10:00' });
  });

  it('grows the end once the finger passes the default end', () => {
    expect(hold(at(10, 7), at(11, 20))).toEqual({ endTime: '11:30', startTime: '10:00' });
  });

  it('grows the start once the finger is a quarter above the touch-down point', () => {
    // 10:07 − one quarter = 09:52: a minute short of it changes nothing.
    expect(hold(at(10, 7), at(9, 53))).toEqual({ endTime: '11:00', startTime: '10:00' });
    expect(hold(at(10, 7), at(9, 52))).toEqual({ endTime: '11:00', startTime: '09:45' });
    expect(hold(at(10, 7), at(9, 10))).toEqual({ endTime: '11:00', startTime: '09:00' });
  });

  it('stays inside the day', () => {
    expect(hold(at(23, 40), at(23, 40))).toEqual({ endTime: '23:59', startTime: '23:30' });
    // 00:20 is in the 00:15 quarter; dragging above midnight stops the start there.
    expect(hold(at(0, 20), -30)).toEqual({ endTime: '01:15', startTime: '00:00' });
    expect(slotFromHold(at(22), at(26))).toEqual({ endMinute: 1440, startMinute: at(22) });
  });
});

describe('slotTimes', () => {
  it('ends a slot that reaches midnight at 23:59', () => {
    expect(slotTimes({ endMinute: 1440, startMinute: at(22) })).toEqual({
      endTime: '23:59',
      startTime: '22:00',
    });
  });
});
