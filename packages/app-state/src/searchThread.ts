import { type LanguageModel, ModelUnavailableError, parseSearchQuery } from '@calendar/ai';
import {
  type CalendarInfo,
  calendarKey,
  changedSearchChips,
  EMPTY_SEARCH_QUERY,
  type SearchNames,
  type SearchQuery,
  searchQueryFromText,
  summarizeSearchChange,
  type TaskListInfo,
  Temporal,
} from '@calendar/core';
import { useRef, useState } from 'react';
import { useToday } from './hooks.ts';
import { useFleetingFlash } from './threadTurns.ts';

/**
 * The search field as a thread: the query it searches for, what the
 * field shows, and the turns — sentences the model read into filters —
 * with Undo. The create thread's shape with another state type: typing
 * sets the words (not a turn), a chip edits a filter (not a turn — the
 * user's own edit, like the form's edits to a draft), a sentence the
 * model reads is a turn, and Undo restores the query as it was before
 * the last one.
 *
 * Pure state and transitions here, tested without React; `useSearchThread`
 * adds the model call.
 */

export interface SearchTurn {
  /** The chips the turn added or changed (`changedSearchChips`): the row flashes them once. */
  readonly chips: ReadonlyArray<string>;
  readonly id: string;
  /** What the turn changed, in words (`summarizeSearchChange`). */
  readonly summary: string;
  readonly utterance: string;
}

export interface SearchThreadState {
  /** The query before each turn, oldest first: what Undo restores. */
  readonly history: ReadonlyArray<SearchQuery>;
  readonly query: SearchQuery;
  /** The words as a turn, an Undo or Clear left them: what the next turn's summary compares with. */
  readonly settledTerms: ReadonlyArray<string>;
  /** What the field shows. */
  readonly text: string;
  readonly turns: ReadonlyArray<SearchTurn>;
  /** Moves when the field must take `text` over (a turn, an Undo, Clear), never while typing. */
  readonly version: number;
}

export const EMPTY_SEARCH_THREAD: SearchThreadState = {
  history: [],
  query: EMPTY_SEARCH_QUERY,
  settledTerms: [],
  text: '',
  turns: [],
  version: 0,
};

let counter = 0;
/** A fresh id for a turn. */
export const nextSearchTurnId = (): string => {
  counter += 1;
  return `search-turn-${counter}`;
};

/** Typing: the words are the field's; the filters stay. Not a turn. */
export const setSearchText = (state: SearchThreadState, text: string): SearchThreadState => ({
  ...state,
  query: { ...state.query, terms: searchQueryFromText(text).terms },
  text,
});

/** A chip edit: the filters as edited, the words left to the field. Not a turn. */
export const setSearchQuery = (
  state: SearchThreadState,
  query: SearchQuery,
): SearchThreadState => ({ ...state, query: { ...query, terms: state.query.terms } });

/** A turn landed: the query before it to the history, the field showing what is left of the words. */
export const applySearchTurn = (
  state: SearchThreadState,
  utterance: string,
  next: SearchQuery,
  { chips = [], summary }: { readonly chips?: ReadonlyArray<string>; readonly summary: string },
  id: string = nextSearchTurnId(),
): SearchThreadState => ({
  history: [...state.history, state.query],
  query: next,
  settledTerms: next.terms,
  text: next.terms.join(' '),
  turns: [...state.turns, { chips, id, summary, utterance }],
  version: state.version + 1,
});

/** The last turn taken back: the query as it was before it, the sentence back in the field. */
export const undoSearchTurn = (state: SearchThreadState): SearchThreadState => {
  const previous = state.history.at(-1);
  if (previous === undefined) {
    return state;
  }
  return {
    history: state.history.slice(0, -1),
    query: previous,
    settledTerms: previous.terms,
    text: previous.terms.join(' '),
    turns: state.turns.slice(0, -1),
    version: state.version + 1,
  };
};

/** "Clear": no words, no filters, no turns. */
export const clearSearchThread = (state: SearchThreadState): SearchThreadState => ({
  ...EMPTY_SEARCH_THREAD,
  version: state.version + 1,
});

/**
 * The thread as a hook. A sentence (`phrase`, the field's text unless
 * given) goes to the model with the filters as they stand and no words —
 * the field holds every word, so the sentence is the words — and lands as
 * a turn; an answer that comes after Clear, Undo, another sentence, or an
 * edit to the words or a chip is dropped (the edit wins). Resolves the
 * message for the field, or nothing when the turn landed.
 */
export const useSearchThread = ({
  calendars,
  model,
  taskLists,
  timeZone,
}: {
  calendars: ReadonlyArray<CalendarInfo>;
  model: LanguageModel;
  taskLists: ReadonlyArray<TaskListInfo>;
  timeZone: string;
}) => {
  const [state, setState] = useState<SearchThreadState>(EMPTY_SEARCH_THREAD);
  const [busy, setBusy] = useState(false);
  // The turn that landed last: its chips flash while it is the newest (an
  // Undo that brings an older one back to the top flashes nothing).
  const [landed, setLanded] = useState<string | null>(null);
  const request = useRef(0);
  const today = useToday(timeZone);
  const names: SearchNames = {
    calendars: calendars.map(({ accountId, id, summary }) => ({ accountId, id, summary })),
    taskLists: taskLists.map(({ accountId, id, title }) => ({ accountId, id, title })),
    today,
  };

  const phrase = async (text: string = state.text): Promise<string | undefined> => {
    const utterance = text.trim();
    if (utterance === '') {
      return undefined;
    }
    const mine = ++request.current;
    const current: SearchQuery = { ...state.query, terms: [] };
    const before: SearchQuery = { ...state.query, terms: state.settledTerms };
    setBusy(true);
    try {
      const result = await parseSearchQuery(model, {
        calendars: calendars
          .filter((calendar) => calendar.isVisible)
          .map((calendar) => ({ key: calendarKey(calendar), name: calendar.summary })),
        current,
        lists: taskLists
          .filter((list) => list.isVisible)
          .map((list) => ({ key: `${list.accountId}:${list.id}`, name: list.title })),
        phrase: utterance,
        referenceDate: Temporal.Now.plainDateISO(timeZone).toString(),
        timeZone,
      });
      if (mine !== request.current) {
        return undefined;
      }
      if (result.kind === 'rejected') {
        return result.reason;
      }
      const change = {
        chips: changedSearchChips(before, result.query, names),
        summary: summarizeSearchChange(before, result.query, names),
      };
      const id = nextSearchTurnId();
      setState((latest) => applySearchTurn(latest, utterance, result.query, change, id));
      setLanded(id);
      return undefined;
    } catch (error) {
      if (mine !== request.current) {
        return undefined;
      }
      return error instanceof ModelUnavailableError
        ? 'On-device model unavailable.'
        : "That couldn't be read — try rephrasing.";
    } finally {
      if (mine === request.current) {
        setBusy(false);
      }
    }
  };

  const newest = state.turns.at(-1);
  const flash = useFleetingFlash(
    newest !== undefined && newest.id === landed
      ? { chips: new Set(newest.chips), key: newest.id }
      : null,
  );

  return {
    busy,
    clear: () => {
      request.current += 1;
      setBusy(false);
      setState((latest) => clearSearchThread(latest));
    },
    /** The chips the newest turn added or changed, while their flash plays. */
    flash,
    names,
    phrase,
    // An edit while a sentence is read wins: the answer, for the words and
    // filters as they were, is dropped rather than laid over the edit.
    setQuery: (query: SearchQuery) => {
      request.current += 1;
      setBusy(false);
      setState((latest) => setSearchQuery(latest, query));
    },
    setText: (text: string) => {
      request.current += 1;
      setBusy(false);
      setState((latest) => setSearchText(latest, text));
    },
    state,
    undo: () => {
      request.current += 1;
      setBusy(false);
      setState((latest) => undoSearchTurn(latest));
    },
  };
};
