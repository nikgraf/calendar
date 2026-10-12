import {
  isBlankSearchQuery,
  type SearchQuery,
  searchQueryKey,
  searchQueryOfKey,
  type SearchResults,
} from '@calendar/core';
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
  /** The settled query's key (`searchQueryKey`): a new one is a new list. */
  readonly key: string;
  /** The query being looked up (blank while there is nothing to look for). */
  readonly query: SearchQuery;
  /** What was found; null while the query is blank and before the first answer. */
  readonly results: SearchResults | null;
  /**
   * The results belong to an earlier query: the latest one is still being
   * typed or looked up. Show them (no flicker), but never as "no matches".
   */
  readonly stale: boolean;
}

const BLANK_KEY = searchQueryKey({ terms: [] });

const IDLE: SearchState = {
  failed: false,
  key: BLANK_KEY,
  query: { terms: [] },
  results: null,
  stale: false,
};

/**
 * Search as the query changes — the words typed, a filter set by hand or
 * read from a sentence: the query is looked up once it rests for
 * SEARCH_DEBOUNCE_MS (a blank one answers at once). Each query has an
 * atom of its own (keyed by `searchQueryKey`), so an answer that arrives
 * late for an earlier query never replaces the latest one's; while the
 * latest is on its way the previous results stay up, marked stale. The
 * atoms re-run on EVENTS_KEY and TASKS_KEY, so an event edited or deleted
 * from a result, a completed task or a sync that changed a match updates
 * the list.
 */
export const useSearch = (query: SearchQuery, timeZone: string): SearchState => {
  const liveKey = searchQueryKey(query);
  const liveBlank = isBlankSearchQuery(query);
  const [key, setKey] = useState(liveKey);
  useEffect(() => {
    const timer = setTimeout(() => setKey(liveKey), liveBlank ? 0 : SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [liveKey, liveBlank]);
  const settled = searchQueryOfKey(key);
  const blank = isBlankSearchQuery(settled);
  const result = useAtomValue(useBackendAtoms().search(searchKey(settled, timeZone)));
  // A blank query's atom answers empty locally: that is no answer here.
  const answer = blank ? null : Option.getOrNull(AsyncResult.value(result));
  const [shown, setShown] = useState<SearchResults | null>(null);
  // Render-phase state adjustment (the React "derive from props" pattern):
  // keep the latest answer, and forget it once the query went blank, so
  // the next query never starts out under an older one's results.
  if (answer === null ? blank && shown !== null : answer !== shown) {
    setShown(answer);
  }
  if (liveBlank) {
    return IDLE;
  }
  return {
    failed: AsyncResult.isFailure(result),
    key,
    query: settled,
    results: answer ?? (blank ? null : shown),
    stale: answer === null || key !== liveKey,
  };
};
