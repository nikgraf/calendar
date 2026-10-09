import { describe, expect, it } from 'vite-plus/test';
import { Attendee, EventRecord, TaskRecord } from '../types.ts';
import { eventMatchesSearch, foldSearchText, searchTerms, taskMatchesSearch } from './match.ts';

const event = (overrides: Partial<EventRecord> = {}) =>
  new EventRecord({
    accountId: 'acc',
    calendarId: 'cal',
    endUtc: 2,
    etag: null,
    id: 'event',
    isAllDay: false,
    startUtc: 1,
    status: 'confirmed',
    syncedAt: 0,
    syncStatus: 'synced',
    title: 'Planning',
    updatedAt: 0,
    ...overrides,
  });

const task = (overrides: Partial<TaskRecord> = {}) =>
  new TaskRecord({
    accountId: 'acc',
    id: 'task',
    listId: 'list',
    provider: 'google',
    status: 'needsAction',
    title: 'Buy milk',
    updatedAt: 0,
    ...overrides,
  });

describe('foldSearchText', () => {
  it('drops case and accents, composed or decomposed, without a locale', () => {
    expect(foldSearchText('Café CRÈME')).toBe('cafe creme');
    // "e" + U+0301 (combining acute), the decomposed spelling of "é".
    expect(foldSearchText('Café')).toBe('cafe');
    expect(foldSearchText('Ångström São Paulo Zürich')).toBe('angstrom sao paulo zurich');
    // Turkish dotted capital I folds to a plain "i", whatever the locale.
    expect(foldSearchText('İstanbul')).toBe('istanbul');
  });
});

describe('searchTerms', () => {
  it('splits a query on any whitespace into folded terms', () => {
    expect(searchTerms('  Café\tcrème Wien\n')).toEqual(['cafe', 'creme', 'wien']);
  });

  it('has no terms for a blank query', () => {
    expect(searchTerms('')).toEqual([]);
    expect(searchTerms(' \t\n')).toEqual([]);
  });
});

describe('eventMatchesSearch', () => {
  it('needs every term, each somewhere in the title, place or notes', () => {
    const lunch = event({
      description: 'Bring the slides',
      location: 'Café Central, Wien',
      title: 'Lunch with Anna',
    });
    expect(eventMatchesSearch(lunch, searchTerms('lunch'))).toBe(true);
    expect(eventMatchesSearch(lunch, searchTerms('LUNCH cafe'))).toBe(true);
    expect(eventMatchesSearch(lunch, searchTerms('wien slides anna'))).toBe(true);
    expect(eventMatchesSearch(lunch, searchTerms('lunch dinner'))).toBe(false);
    // Substrings count: a word typed halfway already finds it.
    expect(eventMatchesSearch(lunch, searchTerms('cent'))).toBe(true);
  });

  it('never matches a term across two fields', () => {
    const meeting = event({ location: 'Room', title: 'Board' });
    expect(eventMatchesSearch(meeting, searchTerms('board'))).toBe(true);
    expect(eventMatchesSearch(meeting, searchTerms('boardroom'))).toBe(false);
  });

  it("finds a guest by name or address, and the organizer's own entry", () => {
    const call = event({
      attendees: [
        new Attendee({
          displayName: 'Zoë Müller',
          email: 'zoe@example.com',
          responseStatus: 'accepted',
        }),
        new Attendee({ email: 'max@example.org', isOrganizer: true, responseStatus: 'accepted' }),
      ],
      title: 'Sync',
    });
    expect(eventMatchesSearch(call, searchTerms('zoe muller'))).toBe(true);
    expect(eventMatchesSearch(call, searchTerms('example.org'))).toBe(true);
    expect(eventMatchesSearch(call, searchTerms('sync max@'))).toBe(true);
    expect(eventMatchesSearch(call, searchTerms('anna'))).toBe(false);
  });

  it('matches nothing for a blank query', () => {
    expect(eventMatchesSearch(event(), searchTerms('   '))).toBe(false);
  });
});

describe('taskMatchesSearch', () => {
  it('reads the title and the notes', () => {
    const errand = task({ notes: 'Oat milk, not the crème fraîche' });
    expect(taskMatchesSearch(errand, searchTerms('buy creme'))).toBe(true);
    expect(taskMatchesSearch(errand, searchTerms('fraiche'))).toBe(true);
    expect(taskMatchesSearch(errand, searchTerms('bread'))).toBe(false);
    expect(taskMatchesSearch(task(), searchTerms(''))).toBe(false);
  });
});
