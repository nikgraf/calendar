import {
  type AttendeeInput,
  type Contact,
  emailKey,
  foldSearchText,
  isValidEmail,
  nameMatch,
} from '@calendar/core';

/**
 * The people a phrase invites, as guests: each name looked up in the
 * contacts (`contactsNamed` — Google's cached address books and the
 * device's, every match), taken when it names one person, else left as a
 * choice for the user — the contacts it might be, or none. An address is
 * a guest as it is. Nothing is sent before Save; the form shows every
 * guest a turn added, and a choice is only ever picked by hand.
 */

/** A name the words invited that found no one contact: who it might be (none: nobody by that name). */
export interface InviteeChoice {
  readonly contacts: ReadonlyArray<Contact>;
  readonly name: string;
}

/** What a turn does to a draft's guests. */
export interface GuestChange {
  readonly add: ReadonlyArray<AttendeeInput>;
  /** Names still to pick from. */
  readonly choices: ReadonlyArray<InviteeChoice>;
  /** Every name the turn invited, as said: an older choice for one gives way to what the turn made of it. */
  readonly invited: ReadonlyArray<string>;
  /** Names or addresses said to take off: matched against the guests when the turn lands. */
  readonly remove: ReadonlyArray<string>;
}

/** Contacts offered for one name, at most. */
export const CHOICE_LIMIT = 5;

const fold = (text: string): string => foldSearchText(text).replaceAll('ß', 'ss').trim();

/**
 * The one person a name means, if it means one: the only one by exactly
 * that name or address, else the only one whose words it says whole ("Tom"
 * for Tom Baker, "T Baker" too) — never one it only begins ("Ann" is not
 * Anna Lee for sure). Two addresses for one person are two: the user
 * picks the address. Decided over every match (`contactsNamed`), never a
 * page of them.
 */
export const pickContact = <
  Person extends { readonly displayName?: string | undefined; readonly email: string },
>(
  name: string,
  people: ReadonlyArray<Person>,
): Person | undefined => {
  const exact = people.filter((person) => nameMatch(name, person) === 'exact');
  if (exact.length > 0) {
    return exact.length === 1 ? exact[0] : undefined;
  }
  const whole = people.filter((person) => nameMatch(name, person) === 'words');
  return whole.length === 1 ? whole[0] : undefined;
};

/**
 * The guests the names make and the names left to pick from. A lookup
 * that fails reads as finding no one: the name is still offered, so the
 * user sees what was said and can type the address.
 */
export const resolveInvitees = async (
  names: ReadonlyArray<string>,
  lookup: (name: string) => Promise<ReadonlyArray<Contact>>,
): Promise<Pick<GuestChange, 'add' | 'choices'>> => {
  const add: Array<AttendeeInput> = [];
  const choices: Array<InviteeChoice> = [];
  for (const name of names) {
    if (isValidEmail(name)) {
      add.push({ email: name.trim() });
      continue;
    }
    const found = await lookup(name).catch(() => []);
    const contact = pickContact(name, found);
    if (contact) {
      add.push({ displayName: contact.displayName, email: contact.email });
    } else {
      choices.push({ contacts: found.slice(0, CHOICE_LIMIT), name });
    }
  }
  return { add, choices };
};

/**
 * The guests a name takes off the list: those by exactly that name or
 * address, else the one guest it names word for word — two of those, or
 * a name that only begins one, and the name says nothing (the user
 * removes the right one).
 */
export const guestsNamed = (
  name: string,
  attendees: ReadonlyArray<AttendeeInput>,
): ReadonlyArray<AttendeeInput> => {
  const exact = attendees.filter((attendee) => nameMatch(name, attendee) === 'exact');
  if (exact.length > 0) {
    return exact;
  }
  const one = pickContact(name, attendees);
  return one === undefined ? [] : [one];
};

/** A choice by its name, as said: the same person said twice is one choice. */
const sameChoice = (a: string, b: string): boolean => fold(a) === fold(b);

/**
 * A draft's guests and open choices after a turn: the guests the turn
 * took off go, then its new ones join (each address once, the order
 * kept); a choice for a name the turn said again — to invite (found this
 * time or not) or to take off — gives way to what the turn made of it.
 */
export const applyGuestChange = (
  attendees: ReadonlyArray<AttendeeInput>,
  choices: ReadonlyArray<InviteeChoice>,
  change: GuestChange,
): {
  /** The guests that joined (not already on the list), for the turn's summary. */
  readonly added: ReadonlyArray<AttendeeInput>;
  readonly attendees: ReadonlyArray<AttendeeInput>;
  readonly choices: ReadonlyArray<InviteeChoice>;
  /** The guests that went, for the turn's summary. */
  readonly removed: ReadonlyArray<AttendeeInput>;
} => {
  const gone = new Set(
    change.remove
      .flatMap((name) => guestsNamed(name, attendees))
      .map((attendee) => emailKey(attendee.email)),
  );
  const kept = attendees.filter((attendee) => !gone.has(emailKey(attendee.email)));
  const taken = new Set(kept.map((attendee) => emailKey(attendee.email)));
  const added: Array<AttendeeInput> = [];
  for (const attendee of change.add) {
    const key = emailKey(attendee.email);
    if (!taken.has(key)) {
      taken.add(key);
      added.push(attendee);
    }
  }
  const said = [
    ...change.invited,
    ...change.remove,
    ...change.choices.map((choice) => choice.name),
  ];
  return {
    added,
    attendees: [...kept, ...added],
    choices: [
      ...choices.filter((choice) => !said.some((name) => sameChoice(name, choice.name))),
      ...change.choices,
    ],
    removed: attendees.filter((attendee) => gone.has(emailKey(attendee.email))),
  };
};

/** A guest by name, for a summary: the name the contact gave, else the address. */
export const guestLabel = (attendee: AttendeeInput): string =>
  attendee.displayName ?? attendee.email;

/** What a choice asks: which of the contacts, or that none has the name. */
export const choiceQuestion = (choice: InviteeChoice): string =>
  choice.contacts.length > 0
    ? `Which ${choice.name}?`
    : `No contact named “${choice.name}” — add an address under Invitees.`;

/** A contact as a choice offers it: its name, with the address when another one there has the same name. */
export const choiceLabel = (contact: Contact, choice: InviteeChoice): string => {
  if (contact.displayName === undefined) {
    return contact.email;
  }
  const shared = choice.contacts.filter((other) => other.displayName === contact.displayName);
  return shared.length > 1 ? `${contact.displayName} · ${contact.email}` : contact.displayName;
};
