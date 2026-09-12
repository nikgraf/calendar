import { emailKey, isValidEmail, type AttendeeInput, type Contact } from '@calendar/core';
import { useEffect, useState } from 'react';
import { useBackendMutations, useContactsSearch } from './hooks.ts';

/** Keystroke → query debounce; one rpc per pause, not per character. */
const DEBOUNCE_MS = 150;

export interface InviteeFieldOptions {
  readonly attendees: ReadonlyArray<AttendeeInput>;
  /** Reads the platform's Contacts permission (preload IPC / Expo module). */
  readonly contactsStatus: () => Promise<string>;
  /** Never removes this address via Backspace (the organizer chip). */
  readonly isProtected?: ((email: string) => boolean) | undefined;
  readonly onAdd: (input: AttendeeInput) => boolean;
  readonly onRemove: (email: string) => void;
}

/**
 * The invitee typeahead's state machine, shared by the desktop combobox
 * and the iOS field: debounced query, suggestions minus the guests
 * already on the list, "stale" rows (still on screen for an earlier
 * query — visible, never auto-picked), the highlight, typed-address
 * acceptance (Enter, comma, blur), Backspace-removes-last-chip, and the
 * Contacts permission ask. The two UIs implemented this separately and
 * the iOS one had none of the debounce, keyboard or stale handling.
 */
export const useInviteeField = ({
  attendees,
  contactsStatus,
  isProtected,
  onAdd,
  onRemove,
}: InviteeFieldOptions) => {
  const [text, setTextState] = useState('');
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [permission, setPermission] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { connectContacts } = useBackendMutations();

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const taken = new Set(attendees.map((attendee) => emailKey(attendee.email)));
  const search = useContactsSearch(query);
  const suggestions = search.contacts.filter((contact) => !taken.has(emailKey(contact.email)));
  const stale = search.stale || query.trim() !== text.trim();
  const highlighted = stale
    ? undefined
    : suggestions[Math.min(highlight, Math.max(suggestions.length - 1, 0))];

  const reset = () => {
    setTextState('');
    setQuery('');
    setHighlight(0);
  };

  const setText = (next: string) => {
    setTextState(next);
    setHighlight(0);
  };

  const choose = (contact: Contact) => {
    onAdd({ displayName: contact.displayName, email: contact.email });
    reset();
  };

  /** Accepts the typed address when it is one; returns whether it did. */
  const addTyped = (): boolean => {
    const trimmed = text.trim().replace(/,$/, '');
    if (!isValidEmail(trimmed)) {
      return false;
    }
    onAdd({ email: trimmed });
    reset();
    return true;
  };

  /** Enter: a fully typed address is explicit; otherwise the highlighted row, if any. */
  const acceptEnter = () => {
    if (isValidEmail(text) || !highlighted) {
      addTyped();
    } else {
      choose(highlighted);
    }
  };

  const moveHighlight = (delta: 1 | -1) => {
    if (stale || suggestions.length === 0) {
      return;
    }
    setHighlight((index) => (index + delta + suggestions.length) % suggestions.length);
  };

  /** Backspace on an empty input removes the last removable chip. */
  const removeLast = (): boolean => {
    if (text !== '' || attendees.length === 0) {
      return false;
    }
    const last = attendees.at(-1)!;
    if (isProtected?.(last.email)) {
      return false;
    }
    onRemove(last.email);
    return true;
  };

  const loadPermission = async () => {
    setPermission(await contactsStatus());
  };

  const allow = async () => {
    setBusy(true);
    try {
      const result = await connectContacts(undefined);
      setPermission(result.granted ? 'authorized' : await contactsStatus());
    } catch {
      setPermission(await contactsStatus());
    } finally {
      setBusy(false);
    }
  };

  return {
    acceptEnter,
    addTyped,
    allow,
    busy,
    choose,
    highlight,
    highlighted,
    loadPermission,
    moveHighlight,
    permission,
    removeLast,
    setHighlight,
    setText,
    stale,
    suggestions,
    text,
  };
};
