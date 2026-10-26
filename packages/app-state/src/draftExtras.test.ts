import { EventReminders, ReminderOverride } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import {
  applyNotesChange,
  applyReminderChange,
  describeNotesChange,
  describeReminderChange,
} from './draftExtras.ts';

const popup = (minutes: number) => new ReminderOverride({ method: 'popup', minutes });
const explicit = (...minutes: ReadonlyArray<number>) =>
  new EventReminders({ overrides: minutes.map(popup), useDefault: false });
const byDefault = new EventReminders({ overrides: [], useDefault: true });
const adds = (...add: ReadonlyArray<number>) => ({ add, clear: false, remove: [] });
const only = (...add: ReadonlyArray<number>) => ({ add, clear: true, remove: [] });
const takesOff = (...remove: ReadonlyArray<number>) => ({ add: [], clear: false, remove });

describe('applyNotesChange', () => {
  it('adds a note on its own line, replaces the notes, or clears them', () => {
    expect(applyNotesChange('', { kind: 'add', text: 'bring wine' })).toBe('bring wine');
    expect(applyNotesChange('bring wine', { kind: 'add', text: 'ask about the trip' })).toBe(
      'bring wine\nask about the trip',
    );
    expect(applyNotesChange('bring wine  \n', { kind: 'add', text: 'cash' })).toBe(
      'bring wine\ncash',
    );
    expect(applyNotesChange('bring wine', { kind: 'replace', text: 'call first' })).toBe(
      'call first',
    );
    expect(applyNotesChange('bring wine', { kind: 'clear' })).toBe('');
  });
});

describe('applyReminderChange', () => {
  it('adds popups to the draft’s own, the calendar default given up', () => {
    expect(applyReminderChange(undefined, adds(30))).toEqual({
      added: [30],
      dropped: [],
      reminders: explicit(30),
      removed: [],
    });
    expect(applyReminderChange(byDefault, adds(30)).reminders).toEqual(explicit(30));
    expect(applyReminderChange(explicit(15), adds(60)).reminders).toEqual(explicit(15, 60));
    // Sorted like every write; one already there is not added again.
    expect(applyReminderChange(explicit(60), adds(15, 60))).toEqual({
      added: [15],
      dropped: [],
      reminders: explicit(15, 60),
      removed: [],
    });
  });

  it('keeps an email reminder through an add', () => {
    const mail = new ReminderOverride({ method: 'email', minutes: 1440 });
    const current = new EventReminders({ overrides: [mail, popup(15)], useDefault: false });
    expect(applyReminderChange(current, adds(60)).reminders).toEqual(
      new EventReminders({ overrides: [mail, popup(15), popup(60)], useDefault: false }),
    );
  });

  it('replaces with only what was said, clears to none, removes the offsets said', () => {
    expect(applyReminderChange(explicit(15, 60), only(10)).reminders).toEqual(explicit(10));
    expect(applyReminderChange(explicit(15), only())).toEqual({
      added: [],
      dropped: [],
      reminders: explicit(),
      removed: [],
    });
    expect(applyReminderChange(byDefault, only()).reminders).toEqual(explicit());
    expect(applyReminderChange(explicit(15, 60), takesOff(15))).toEqual({
      added: [],
      dropped: [],
      reminders: explicit(60),
      removed: [15],
    });
    // Review: a removal and an addition in one breath both take effect.
    expect(
      applyReminderChange(explicit(15, 30), { add: [60], clear: false, remove: [15] }),
    ).toEqual({ added: [60], dropped: [], reminders: explicit(30, 60), removed: [15] });
  });

  it('leaves the draft as it was when nothing takes effect', () => {
    // Nothing of its own to take off: the draft stays on the default.
    expect(applyReminderChange(undefined, takesOff(15)).reminders).toBeUndefined();
    expect(applyReminderChange(byDefault, takesOff(15)).reminders).toBe(byDefault);
    const own = explicit(15);
    expect(applyReminderChange(own, adds(15)).reminders).toBe(own);
    // Review: an offset beyond Google's four weeks is not added, and the
    // calendar default stays.
    expect(applyReminderChange(byDefault, adds(50_000)).reminders).toBe(byDefault);
  });

  it('never lets a new offset push one of the draft’s own out', () => {
    // Review: the form allows five; the sixth is dropped, not the largest one.
    const full = explicit(5, 10, 15, 30, 60);
    expect(applyReminderChange(full, adds(0))).toEqual({
      added: [],
      dropped: [0],
      reminders: full,
      removed: [],
    });
    expect(applyReminderChange(explicit(5, 10, 15, 30), adds(0, 120))).toEqual({
      added: [0],
      dropped: [120],
      reminders: explicit(0, 5, 10, 15, 30),
      removed: [],
    });
  });
});

describe('the words of a change', () => {
  it('say what the turn did', () => {
    expect(describeNotesChange({ kind: 'add', text: 'x' })).toBe('adds a note');
    expect(describeNotesChange({ kind: 'replace', text: 'x' })).toBe('replaces the notes');
    expect(describeNotesChange({ kind: 'clear' })).toBe('clears the notes');
    const said = (change: Parameters<typeof applyReminderChange>[1], isAllDay = false) =>
      describeReminderChange(change, applyReminderChange(explicit(15), change), isAllDay);
    expect(said(adds(30, 60))).toEqual(['notifies 30 minutes before, 1 hour before']);
    expect(said(adds(0))).toEqual(['notifies at time of event']);
    expect(said(adds(1440), true)).toEqual(['notifies 1 day before']);
    expect(said(only(10))).toEqual(['notifies only 10 minutes before']);
    expect(said(takesOff(15))).toEqual(['no longer notifies 15 minutes before']);
    expect(said(only())).toEqual(['no notifications']);
    expect(said({ add: [60], clear: false, remove: [15] })).toEqual([
      'notifies 1 hour before',
      'no longer notifies 15 minutes before',
    ]);
    // Nothing happened: nothing said, but an offset without room is named.
    expect(said(adds(15))).toEqual([]);
    expect(
      describeReminderChange(
        adds(0),
        applyReminderChange(explicit(5, 10, 15, 30, 60), adds(0)),
        false,
      ),
    ).toEqual(['at most 5 notifications']);
  });
});
