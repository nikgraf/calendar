import { EventReminders, GeoLocation } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import { eventEditorChanges, type EventEditorText, vouchedGeo } from './eventEditorChanges.ts';

const cafe = new GeoLocation({ lat: 52.52, lng: 13.405, name: 'Café Mitte', source: 'Café Mitte' });

const initial: EventEditorText = {
  description: 'Bring the slides',
  geo: cafe,
  location: 'Café Mitte',
  title: 'Design review',
};

/** The form with `current` edited, nothing else touched. */
const diff = (
  current: Partial<EventEditorText>,
  rest: Partial<Omit<Parameters<typeof eventEditorChanges>[0], 'current' | 'initial'>> = {},
) =>
  eventEditorChanges({
    attendees: undefined,
    current: { ...initial, ...current },
    initial,
    recurrence: undefined,
    reminders: undefined,
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

  it('the kind rides with the times, and only with them', () => {
    const times = { endUtc: 2, isAllDay: false, startTimeZone: 'UTC', startUtc: 1 };
    expect(diff({}, { times })).toEqual(times);
  });

  it('passes the edited guests, notifications and rule through, clears included', () => {
    const reminders = new EventReminders({ overrides: [], useDefault: false });
    expect(diff({}, { attendees: [], recurrence: null, reminders })).toEqual({
      attendees: [],
      recurrence: null,
      reminders,
    });
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
