import { EventReminders, GeoLocation, ReminderOverride } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import {
  eventEditorChanges,
  type EventEditorValues,
  guestsKey,
  remindersKey,
  vouchedGeo,
} from './eventEditorChanges.ts';

const cafe = new GeoLocation({ lat: 52.52, lng: 13.405, name: 'Café Mitte', source: 'Café Mitte' });
const sarah = { displayName: 'Sarah Keller', email: 'sarah@example.com' };
const tom = { displayName: 'Tom Brandt', email: 'tom.brandt@example.com' };
const popups = (...minutes: ReadonlyArray<number>) =>
  new EventReminders({
    overrides: minutes.map((offset) => new ReminderOverride({ method: 'popup', minutes: offset })),
    useDefault: false,
  });

const initial: EventEditorValues = {
  attendees: [sarah],
  description: 'Bring the slides',
  geo: cafe,
  location: 'Café Mitte',
  reminders: popups(30),
  title: 'Design review',
};

/** The form with `current` edited, nothing else touched. */
const diff = (
  current: Partial<EventEditorValues>,
  rest: Partial<Omit<Parameters<typeof eventEditorChanges>[0], 'current' | 'initial'>> = {},
) =>
  eventEditorChanges({
    current: { ...initial, ...current },
    initial,
    recurrence: undefined,
    times: undefined,
    ...rest,
  });

describe('eventEditorChanges', () => {
  it('an untouched Save sends nothing — not even the text the form shows', () => {
    expect(diff({})).toEqual({});
  });

  it('a title-only edit sends no notes and no location, whatever they hold now', () => {
    expect(diff({ title: 'Design review (moved)' })).toEqual({ title: 'Design review (moved)' });
  });

  it('sends the notes only when edited, cleared ones as empty text', () => {
    expect(diff({ description: 'Bring the slides and the demo' })).toEqual({
      description: 'Bring the slides and the demo',
    });
    expect(diff({ description: '' })).toEqual({ description: '' });
  });

  it('a new location goes with its coordinates: picked ones, else null', () => {
    const office = new GeoLocation({ lat: 52.5, lng: 13.4, source: 'Office' });
    expect(diff({ geo: office, location: 'Office' })).toEqual({ geo: office, location: 'Office' });
    // Typed, never picked: the old coordinates no longer match, so they clear.
    expect(diff({ location: 'Room 4B' })).toEqual({ geo: null, location: 'Room 4B' });
    expect(diff({ location: '' })).toEqual({ geo: null, location: '' });
  });

  it('retyping the opened location is no change', () => {
    expect(diff({ location: initial.location })).toEqual({});
  });

  it('a place picked for the same text sends the pair', () => {
    const picked = new GeoLocation({ lat: 52.53, lng: 13.41, source: 'Café Mitte' });
    expect(diff({ geo: picked })).toEqual({ geo: picked, location: 'Café Mitte' });
  });

  it('the same coordinates as another object are no change', () => {
    expect(diff({ geo: new GeoLocation({ ...cafe }) })).toEqual({});
  });

  it('the place kept as said sends the text with its coordinates cleared', () => {
    expect(diff({ geo: undefined })).toEqual({ geo: null, location: 'Café Mitte' });
  });

  it('coordinates that did not match the opened text were never vouched for: losing them is no change', () => {
    const stale = new GeoLocation({ lat: 1, lng: 2, source: 'Somewhere else' });
    expect(
      eventEditorChanges({
        current: { ...initial, geo: undefined },
        initial: { ...initial, geo: stale },
        recurrence: undefined,
        times: undefined,
      }),
    ).toEqual({});
  });

  it('the kind rides with the times, and only with them', () => {
    const times = { endUtc: 2, isAllDay: false, startTimeZone: 'UTC', startUtc: 1 };
    expect(diff({}, { times })).toEqual(times);
  });

  it('sends the guests only when the list is another one, an emptied list included', () => {
    expect(diff({ attendees: [sarah, tom] })).toEqual({ attendees: [sarah, tom] });
    expect(diff({ attendees: [] })).toEqual({ attendees: [] });
  });

  it('the same guests in another order, or as another object, are no change', () => {
    const both = { ...initial, attendees: [sarah, tom] };
    expect(
      eventEditorChanges({
        current: { ...both, attendees: [{ email: ' TOM.brandt@example.com' }, { ...sarah }] },
        initial: both,
        recurrence: undefined,
        times: undefined,
      }),
    ).toEqual({});
  });

  it('sends the notifications only when they notify differently', () => {
    expect(diff({ reminders: popups(30, 60) })).toEqual({ reminders: popups(30, 60) });
    expect(diff({ reminders: popups() })).toEqual({ reminders: popups() });
    // The same offsets, written again: nothing to send.
    expect(diff({ reminders: popups(30, 30) })).toEqual({});
  });

  it('a calendar default reads the same whatever offsets ride along unused', () => {
    const byDefault = new EventReminders({ overrides: [], useDefault: true });
    const withLeftovers = new EventReminders({ overrides: popups(15).overrides, useDefault: true });
    expect(
      eventEditorChanges({
        current: { ...initial, reminders: withLeftovers },
        initial: { ...initial, reminders: byDefault },
        recurrence: undefined,
        times: undefined,
      }),
    ).toEqual({});
  });

  it('passes a decided rule through, a cleared one as null', () => {
    expect(diff({}, { recurrence: null })).toEqual({ recurrence: null });
    expect(diff({}, { recurrence: ['RRULE:FREQ=WEEKLY'] })).toEqual({
      recurrence: ['RRULE:FREQ=WEEKLY'],
    });
  });

  it('everything put back as it opened is an untouched Save', () => {
    expect(
      diff({
        attendees: [{ ...sarah }],
        description: initial.description,
        geo: new GeoLocation({ ...cafe }),
        reminders: popups(30),
        title: initial.title,
      }),
    ).toEqual({});
  });
});

describe('remindersKey and guestsKey', () => {
  it('reads untouched notifications as the calendar default', () => {
    expect(remindersKey(undefined)).toBe('default');
    expect(remindersKey(new EventReminders({ overrides: [], useDefault: true }))).toBe('default');
    expect(remindersKey(popups())).toBe('');
    expect(remindersKey(popups(60, 10))).toBe(remindersKey(popups(10, 60)));
  });

  it('reads a guest list by its addresses', () => {
    expect(guestsKey([sarah, tom])).toBe(guestsKey([tom, sarah]));
    expect(guestsKey([sarah])).not.toBe(guestsKey([sarah, tom]));
  });
});

describe('vouchedGeo', () => {
  it('keeps coordinates only while they match the text, under its spelling', () => {
    expect(vouchedGeo(cafe, 'café mitte')).toEqual(
      new GeoLocation({ ...cafe, source: 'café mitte' }),
    );
    expect(vouchedGeo(cafe, 'Office')).toBeUndefined();
    expect(vouchedGeo(undefined, 'Café Mitte')).toBeUndefined();
  });
});
