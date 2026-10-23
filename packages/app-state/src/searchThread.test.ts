import { describe, expect, it } from 'vite-plus/test';
import {
  applySearchTurn,
  clearSearchThread,
  EMPTY_SEARCH_THREAD,
  restartSearchThread,
  setSearchQuery,
  setSearchText,
  undoSearchTurn,
} from './searchThread.ts';

describe('the search thread', () => {
  it('typing sets the words, keeps the filters, and leaves the version', () => {
    const typed = setSearchText(
      setSearchQuery(EMPTY_SEARCH_THREAD, { kind: 'task', terms: [] }),
      ' harbour  lunch ',
    );
    expect(typed.query).toEqual({ kind: 'task', terms: ['harbour', 'lunch'] });
    expect(typed.text).toBe(' harbour  lunch ');
    expect(typed.version).toBe(0);
    expect(typed.turns).toEqual([]);
  });

  it('a chip edit is not a turn and never touches the words', () => {
    const typed = setSearchText(EMPTY_SEARCH_THREAD, 'harbour');
    const edited = setSearchQuery(typed, { location: 'Hafen', terms: ['other'] });
    expect(edited.query).toEqual({ location: 'Hafen', terms: ['harbour'] });
    expect(edited.history).toEqual([]);
    expect(edited.version).toBe(0);
  });

  it('a turn keeps the query before it, puts what is left of the words in the field, and moves the version', () => {
    const typed = setSearchText(EMPTY_SEARCH_THREAD, 'harbour last month');
    const turned = applySearchTurn(
      typed,
      'harbour last month',
      { from: '2026-09-01', terms: ['harbour'], to: '2026-09-30' },
      { chips: ['dates:'], summary: '→ “harbour” · → Sep 1 – Sep 30' },
      't1',
    );
    expect(turned.history).toEqual([{ terms: ['harbour', 'last', 'month'] }]);
    expect(turned.text).toBe('harbour');
    expect(turned.settledTerms).toEqual(['harbour']);
    expect(turned.turns).toEqual([
      {
        chips: ['dates:'],
        id: 't1',
        summary: '→ “harbour” · → Sep 1 – Sep 30',
        utterance: 'harbour last month',
      },
    ]);
    expect(turned.version).toBe(1);
  });

  it('Undo restores the query before the last turn — chip edits made after it go, the sentence comes back', () => {
    const typed = setSearchText(EMPTY_SEARCH_THREAD, 'harbour last month');
    const turned = applySearchTurn(
      typed,
      'harbour last month',
      { from: '2026-09-01', terms: ['harbour'] },
      { summary: 's' },
      't1',
    );
    const edited = setSearchQuery(turned, { from: '2026-09-01', kind: 'event', terms: [] });
    const undone = undoSearchTurn(edited);
    expect(undone.query).toEqual({ terms: ['harbour', 'last', 'month'] });
    expect(undone.text).toBe('harbour last month');
    expect(undone.turns).toEqual([]);
    expect(undone.version).toBe(2);
    expect(undoSearchTurn(undone)).toBe(undone);
  });

  it('Clear empties everything and moves the version', () => {
    const turned = applySearchTurn(
      setSearchText(EMPTY_SEARCH_THREAD, 'x'),
      'x',
      { kind: 'task', terms: ['x'] },
      { summary: 's' },
    );
    expect(clearSearchThread(turned)).toEqual({ ...EMPTY_SEARCH_THREAD, version: 2 });
  });

  it('a restart drops the filters and turns an earlier search left, and holds the new words', () => {
    const earlier = applySearchTurn(
      setSearchQuery(EMPTY_SEARCH_THREAD, { location: 'Hafen', terms: [] }),
      'in the harbour',
      { location: 'Hafen', terms: ['lunch'] },
      { summary: 'in Hafen' },
      'turn-1',
    );
    const restarted = restartSearchThread(earlier, 'meetings with Sam last month');
    expect(restarted.query).toEqual({ terms: ['meetings', 'with', 'Sam', 'last', 'month'] });
    expect(restarted.turns).toEqual([]);
    expect(restarted.history).toEqual([]);
    expect(restarted.text).toBe('meetings with Sam last month');
    expect(restarted.version).toBe(earlier.version + 1);
  });
});
