import { isMappableLocation, type PlaceSuggestion } from '@calendar/core';
import { useEffect, useState } from 'react';
import { usePlacesSearch } from './hooks.ts';

/** Keystroke → query debounce; one MapKit round trip per pause, not per character. */
const DEBOUNCE_MS = 150;
/** Fewer characters narrow nothing down; the backend enforces the same floor. */
const MIN_QUERY_LENGTH = 3;

export interface LocationFieldOptions {
  readonly location: string;
  /** Resolves and applies a picked row (the editor model's pickPlace). */
  readonly onPick: (suggestion: PlaceSuggestion) => void;
  readonly setLocation: (location: string) => void;
}

/**
 * The location typeahead's state machine, shared by the desktop combobox
 * and the iOS field. The input edits the location text directly — free
 * text is always a valid location; a suggestion only adds coordinates.
 * Suggestions appear once the user types (never for the text the editor
 * opened with), debounced, and not for URLs or meeting links; "stale"
 * rows belong to an earlier query and can be seen but not picked.
 */
export const useLocationField = ({ location, onPick, setLocation }: LocationFieldOptions) => {
  const [typing, setTyping] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);

  const wanted =
    typing && isMappableLocation(location) && location.trim().length >= MIN_QUERY_LENGTH
      ? location
      : '';
  useEffect(() => {
    const timer = setTimeout(() => setQuery(wanted), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [wanted]);

  const search = usePlacesSearch(wanted === '' ? '' : query);
  const suggestions = wanted === '' ? [] : search.places;
  const stale = search.stale || query.trim() !== wanted.trim();
  const highlighted = stale
    ? undefined
    : suggestions[Math.min(highlight, Math.max(suggestions.length - 1, 0))];

  const setText = (next: string) => {
    setLocation(next);
    setTyping(true);
    setHighlight(0);
  };

  const choose = (suggestion: PlaceSuggestion) => {
    setTyping(false);
    setHighlight(0);
    onPick(suggestion);
  };

  /** Enter picks the highlighted row; returns whether it consumed the key. */
  const acceptEnter = (): boolean => {
    if (!highlighted) {
      return false;
    }
    choose(highlighted);
    return true;
  };

  const moveHighlight = (delta: 1 | -1) => {
    if (stale || suggestions.length === 0) {
      return;
    }
    setHighlight((index) => (index + delta + suggestions.length) % suggestions.length);
  };

  /** Escape / blur: hide the rows and keep the text as typed. */
  const dismiss = () => {
    setTyping(false);
    setHighlight(0);
  };

  return {
    acceptEnter,
    choose,
    dismiss,
    highlight,
    highlighted,
    moveHighlight,
    open: suggestions.length > 0,
    setHighlight,
    setText,
    stale,
    suggestions,
  };
};
