import { useAccounts, useBackendMutations, useContactsSearch } from '@calendar/app-state';
import {
  emailKey,
  isValidEmail,
  type Attendee,
  type AttendeeInput,
  type Contact,
} from '@calendar/core';
import { useEffect, useId, useState } from 'react';

const STATUS_DOT: Record<Attendee['responseStatus'], string> = {
  accepted: 'bg-green-500',
  declined: 'bg-red-500',
  needsAction: 'bg-neutral-300',
  tentative: 'bg-amber-400',
};

const DEBOUNCE_MS = 150;

/**
 * Guest chips + a typeahead over device and Google contacts. Hand-rolled
 * (no UI library in the repo): the listbox is absolutely positioned under
 * the input, ArrowUp/Down move the highlight, Enter takes the highlight
 * or the typed address, comma and blur take a typed address, Backspace on
 * an empty input removes the last chip, Escape closes the list without
 * closing the editor.
 */
export function InviteeCombobox({
  attendees,
  attendeeStatus,
  onAdd,
  onRemove,
}: {
  attendees: ReadonlyArray<AttendeeInput>;
  attendeeStatus: (email: string) => Attendee | undefined;
  onAdd: (input: AttendeeInput) => boolean;
  onRemove: (email: string) => void;
}) {
  const [text, setText] = useState('');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const [permission, setPermission] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const listId = useId();
  const { connectContacts } = useBackendMutations();
  const accounts = useAccounts();
  const googleContactsEnabled = accounts.some(
    (account) => account.provider === 'google' && account.contactsEnabled,
  );

  useEffect(() => {
    const timer = setTimeout(() => setQuery(text), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [text]);

  useEffect(() => {
    if (!open || permission !== null) {
      return;
    }
    let mounted = true;
    void window.calendarBridge.contactsStatus().then((status) => {
      if (mounted) {
        setPermission(status);
      }
    });
    return () => {
      mounted = false;
    };
  }, [open, permission]);

  const taken = new Set(attendees.map((attendee) => emailKey(attendee.email)));
  const suggestions = useContactsSearch(query).filter(
    (contact) => !taken.has(emailKey(contact.email)),
  );
  const highlighted = suggestions[Math.min(highlight, Math.max(suggestions.length - 1, 0))];

  const choose = (contact: Contact) => {
    onAdd({ displayName: contact.displayName, email: contact.email });
    setText('');
    setQuery('');
    setHighlight(0);
  };

  const addTyped = (): boolean => {
    const trimmed = text.trim().replace(/,$/, '');
    if (!isValidEmail(trimmed)) {
      return false;
    }
    onAdd({ email: trimmed });
    setText('');
    setQuery('');
    setHighlight(0);
    return true;
  };

  const allow = async () => {
    setBusy(true);
    try {
      const result = await connectContacts(undefined);
      setPermission(result.granted ? 'authorized' : await window.calendarBridge.contactsStatus());
    } catch {
      setPermission(await window.calendarBridge.contactsStatus());
    } finally {
      setBusy(false);
    }
  };

  const showList = open && (text.trim() !== '' || permission === 'notDetermined');
  const footer =
    permission === 'notDetermined' ? (
      <button
        className="w-full px-3 py-2 text-left text-xs text-blue-600 hover:bg-neutral-50"
        disabled={busy}
        onClick={() => void allow()}
        onMouseDown={(mouseEvent) => mouseEvent.preventDefault()}
        type="button"
      >
        Allow access to Contacts to suggest people from your address book
      </button>
    ) : permission === 'denied' ? (
      <p className="px-3 py-2 text-xs text-neutral-400">
        Contacts access is off — System Settings › Privacy &amp; Security › Contacts
      </p>
    ) : !googleContactsEnabled && accounts.some((account) => account.provider === 'google') ? (
      <p className="px-3 py-2 text-xs text-neutral-400">
        Re-add your Google account to search Google contacts
      </p>
    ) : null;

  return (
    <div className="relative">
      <div className="flex flex-wrap items-center gap-1 rounded-lg border border-neutral-200 bg-white px-2 py-1">
        {attendees.map((attendee) => {
          const status = attendeeStatus(attendee.email);
          return (
            <span
              className="inline-flex items-center gap-1 rounded-md bg-neutral-100 px-2 py-0.5 text-xs"
              data-invitee={attendee.email}
              key={emailKey(attendee.email)}
              title={`${attendee.email}${status ? ` · ${status.responseStatus}` : ''}`}
            >
              <span
                className={`inline-block size-1.5 rounded-full ${STATUS_DOT[status?.responseStatus ?? 'needsAction']}`}
              />
              <span className="select-text">{attendee.displayName ?? attendee.email}</span>
              {status?.isOrganizer ? (
                <span className="text-neutral-400">organizer</span>
              ) : (
                <button
                  aria-label={`Remove ${attendee.email}`}
                  className="ml-0.5 text-neutral-400 hover:text-neutral-700"
                  onClick={() => onRemove(attendee.email)}
                  type="button"
                >
                  ×
                </button>
              )}
            </span>
          );
        })}
        <input
          aria-activedescendant={showList && highlighted ? `${listId}-${highlight}` : undefined}
          aria-autocomplete="list"
          aria-controls={listId}
          aria-expanded={showList}
          aria-label="Invitees"
          autoComplete="off"
          className="min-w-32 flex-1 bg-transparent px-1 py-0.5 text-sm outline-none"
          onBlur={() => {
            addTyped();
            setOpen(false);
          }}
          onChange={(changeEvent) => {
            setText(changeEvent.target.value);
            setHighlight(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(keyEvent) => {
            if (keyEvent.key === 'ArrowDown' && suggestions.length > 0) {
              keyEvent.preventDefault();
              setHighlight((index) => (index + 1) % suggestions.length);
            } else if (keyEvent.key === 'ArrowUp' && suggestions.length > 0) {
              keyEvent.preventDefault();
              setHighlight((index) => (index - 1 + suggestions.length) % suggestions.length);
            } else if (keyEvent.key === 'Enter') {
              keyEvent.preventDefault();
              // A fully typed address is explicit; the highlight may still
              // belong to the previous query while this one loads.
              if (isValidEmail(text) || !showList || !highlighted) {
                addTyped();
              } else {
                choose(highlighted);
              }
            } else if (keyEvent.key === ',') {
              if (addTyped()) {
                keyEvent.preventDefault();
              }
            } else if (keyEvent.key === 'Escape' && showList) {
              keyEvent.stopPropagation();
              setOpen(false);
            } else if (keyEvent.key === 'Backspace' && text === '' && attendees.length > 0) {
              const last = attendees.at(-1)!;
              if (!attendeeStatus(last.email)?.isOrganizer) {
                onRemove(last.email);
              }
            }
          }}
          placeholder={attendees.length === 0 ? 'Add guests' : ''}
          role="combobox"
          value={text}
        />
      </div>
      {showList ? (
        <div
          className="absolute top-full right-0 left-0 z-50 mt-1 overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-xl"
          id={listId}
          role="listbox"
        >
          {suggestions.map((contact, index) => (
            <button
              aria-selected={index === highlight}
              className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm ${
                index === highlight ? 'bg-blue-50' : 'hover:bg-neutral-50'
              }`}
              id={`${listId}-${index}`}
              key={contact.id}
              onClick={() => choose(contact)}
              onMouseDown={(mouseEvent) => mouseEvent.preventDefault()}
              onMouseEnter={() => setHighlight(index)}
              role="option"
              type="button"
            >
              <span>{contact.displayName ?? contact.email}</span>
              {contact.displayName ? (
                <span className="truncate text-xs text-neutral-400">{contact.email}</span>
              ) : null}
              <span className="ml-auto text-[10px] text-neutral-300 uppercase">
                {contact.source === 'device' ? 'Contacts' : contact.isOtherContact ? '' : 'Google'}
              </span>
            </button>
          ))}
          {suggestions.length === 0 && text.trim() !== '' ? (
            <p className="px-3 py-1.5 text-xs text-neutral-400">
              {isValidEmail(text) ? 'Press Enter to invite this address' : 'No matches'}
            </p>
          ) : null}
          {footer}
        </div>
      ) : null}
    </div>
  );
}
