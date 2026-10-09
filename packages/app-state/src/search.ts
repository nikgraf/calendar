import type { SearchResults } from '@calendar/core';
import { useAtomValue } from '@effect/atom-react';
import { Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { useEffect, useState } from 'react';
import { searchKey } from './atoms.ts';
import { useBackendAtoms } from './hooks.ts';

/** Keystroke → search debounce: one backend call per pause in typing. */
export const SEARCH_DEBOUNCE_MS = 200;

export interface SearchState {
  /** The latest query's search failed; `results` are an earlier query's, if any. */
  readonly failed: boolean;
  /** The trimmed query being looked up ('' while the field is blank). */
  readonly query: string;
  /** What was found; null while the field is blank and before the first answer. */
  readonly results: SearchResults | null;
  /**
   * The results belong to an earlier query: the latest one is still being
   * typed or looked up. Show them (no flicker), but never as "no matches".
   */
  readonly stale: boolean;
}

const IDLE: SearchState = { failed: false, query: '', results: null, stale: false };

/**
 * Search as the field is typed: the trimmed text is looked up once typing
 * pauses for SEARCH_DEBOUNCE_MS (a cleared field answers at once). Each
 * query has an atom of its own, so an answer that arrives late for an
 * earlier query never replaces the latest one's; while the latest is on
 * its way the previous results stay up, marked stale. The atoms re-run on
 * EVENTS_KEY and TASKS_KEY, so an event edited or deleted from a result,
 * a completed task or a sync that changed a match updates the list.
 */
export const useSearch = (text: string, timeZone: string): SearchState => {
  const typed = text.trim();
  const [query, setQuery] = useState(typed);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(typed), typed === '' ? 0 : SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [typed]);
  const result = useAtomValue(useBackendAtoms().search(searchKey(query, timeZone)));
  // A blank query's atom answers empty locally: that is no answer here.
  const answer = query === '' ? null : Option.getOrNull(AsyncResult.value(result));
  const [shown, setShown] = useState<SearchResults | null>(null);
  // Render-phase state adjustment (the React "derive from props" pattern):
  // keep the latest answer, and forget it once the field was cleared, so
  // the next query never starts out under an older one's results.
  if (answer === null ? query === '' && shown !== null : answer !== shown) {
    setShown(answer);
  }
  if (typed === '') {
    return IDLE;
  }
  return {
    failed: AsyncResult.isFailure(result),
    query,
    results: answer ?? (query === '' ? null : shown),
    stale: answer === null || query !== typed,
  };
};
