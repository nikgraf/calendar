import { describe, expect, it } from 'vite-plus/test';
import { Attendee, Contact, EventRecord, GeoLocation } from '../types.ts';
import { dictationVocabulary } from './vocabulary.ts';

const event = (id: string, at: number, overrides: Partial<EventRecord> = {}): EventRecord =>
  new EventRecord({
    accountId: 'acc',
    calendarId: 'cal',
    endUtc: at + 1,
    etag: null,
    id,
    isAllDay: false,
    startUtc: at,
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: id,
    updatedAt: 0,
    ...overrides,
  });

const guest = (displayName: string | undefined, more: Partial<Attendee> = {}) =>
  new Attendee({
    email: `${displayName ?? 'x'}@example.com`,
    responseStatus: 'accepted',
    ...(displayName === undefined ? {} : { displayName }),
    ...more,
  });

const contact = (displayName: string) =>
  new Contact({
    displayName,
    email: `${displayName}@example.com`,
    id: displayName,
    source: 'device',
  });

describe('dictationVocabulary', () => {
  it('lists the guests met most first, then the contacts not met, without the user or rooms', () => {
    const events = [
      event('a', 1, { attendees: [guest('Thomas Karpfeneder'), guest('Me', { isSelf: true })] }),
      event('b', 2, { attendees: [guest('Katharina Gruber'), guest('Thomas  Karpfeneder')] }),
      event('c', 3, { attendees: [guest('Room 4', { isResource: true }), guest(undefined)] }),
      event('d', 4, { attendees: [guest('Jörg Hofstätter')], status: 'cancelled' }),
    ];
    const contacts = [contact('Emily Carter'), contact('katharina gruber'), contact('Al')];
    expect(dictationVocabulary(events, contacts).people).toEqual([
      'Thomas Karpfeneder',
      'Katharina Gruber',
      'Al',
      'Emily Carter',
    ]);
  });

  it('lists the places as said: MapKit’s name, else the text before a comma, no house number', () => {
    const events = [
      event('a', 1, { location: 'Figlmüller, Wollzeile 5, 1010 Wien' }),
      event('b', 2, {
        geo: new GeoLocation({ lat: 0, lng: 0, name: 'Café Prückel', source: 'Stubenring 24' }),
        location: 'Stubenring 24',
      }),
      event('c', 3, { location: 'Neubaugasse 12' }),
      event('d', 4, { location: 'https://meet.google.com/abc-defg-hij' }),
      event('e', 5, { location: 'Figlmüller' }),
    ];
    expect(dictationVocabulary(events, []).places).toEqual([
      'Figlmüller',
      'Neubaugasse',
      'Café Prückel',
    ]);
  });

  it('keeps no more than the limit of each', () => {
    const events = ['A', 'B', 'C'].map((name, index) =>
      event(name, index, { attendees: [guest(`${name} Person`)], location: `${name} Platz` }),
    );
    expect(dictationVocabulary(events, [], 2)).toEqual({
      people: ['C Person', 'B Person'],
      places: ['C Platz', 'B Platz'],
    });
  });
});
