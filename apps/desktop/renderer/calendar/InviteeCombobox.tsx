import { useAccounts, useInviteeField } from '@calendar/app-state';
import { emailKey, isValidEmail, type Attendee, type AttendeeInput } from '@calendar/core';
import { useEffect, useId, useState } from 'react';

const STATUS_DOT: Record<Attendee['responseStatus'], string> = {
  accepted: 'bg-green-500',
  declined: 'bg-red-500',
  needsAction: 'bg-neutral-300',
  tentative: 'bg-amber-400',
};

const contactsStatus = (): Promise<string> =>
  window.calendarBridge.contactsStatus() as Promise<string>;

/**
 * Guest chips + a typeahead over device and Google contacts. Hand-rolled
 * (no UI library in the repo): the listbox is absolutely positioned under
 * the input, ArrowUp/Down move the highlight, Enter takes the highlight
 * or the typed address, comma and blur take a typed address, Backspace on
 * an empty input removes the last chip, Escape closes the list without
 * closing the editor. The state machine is useInviteeField, shared with
 * the iOS field.
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
  const [open, setOpen] = useState(false);
  const listId = useId();
  const accounts = useAccounts();
  const googleContactsEnabled = accounts.some(
    (account) => account.provider === 'google' && account.contactsEnabled,
  );
  const {
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
  } = useInviteeField({
    attendees,
    contactsStatus,
    isProtected: (email) => attendeeStatus(email)?.isOrganizer === true,
    onAdd,
    onRemove,
  });

  useEffect(() => {
    if (open && permission === null) {
      void loadPermission();
    }
  }, [open, permission, loadPermission]);

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
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(keyEvent) => {
            if (keyEvent.key === 'ArrowDown') {
              keyEvent.preventDefault();
              moveHighlight(1);
            } else if (keyEvent.key === 'ArrowUp') {
              keyEvent.preventDefault();
              moveHighlight(-1);
            } else if (keyEvent.key === 'Enter') {
              keyEvent.preventDefault();
              if (showList) {
                acceptEnter();
              } else {
                addTyped();
              }
            } else if (keyEvent.key === ',') {
              if (addTyped()) {
                keyEvent.preventDefault();
              }
            } else if (keyEvent.key === 'Escape' && showList) {
              keyEvent.stopPropagation();
              setOpen(false);
            } else if (keyEvent.key === 'Backspace') {
              removeLast();
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
              aria-selected={!stale && index === highlight}
              className={`flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm ${
                stale ? 'opacity-50' : index === highlight ? 'bg-blue-50' : 'hover:bg-neutral-50'
              }`}
              data-stale={stale ? 'true' : undefined}
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
