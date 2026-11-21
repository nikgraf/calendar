import {
  type Account,
  type CalendarInfo,
  isAppleCalendarAccount,
  isAppleRemindersAccount,
  isCalendarWritable,
  MIRROR_DEFAULT_BUSY_LABEL,
  MIRROR_DEFAULT_MONTHS,
  MIRROR_PRESETS,
  type MirrorCalendarRef,
  type MirrorDefinition,
  mirrorRefKey,
  type MirrorSourceRef,
  type MirrorView,
  portableCalendarRef,
  type TaskListInfo,
} from '@calendar/core';

/**
 * What both platforms' mirror editors share: the choices a user can make
 * from the accounts, calendars and lists this device knows, the draft
 * they edit, and the checks before Save. The forms themselves stay per
 * platform.
 */

/** A definition being edited: everything but the stamp, which Save sets. */
export type MirrorDraft = Omit<MirrorDefinition, 'destination' | 'updatedAt'> & {
  readonly destination: MirrorCalendarRef | undefined;
};

/** A calendar or list a user can pick, named the portable way. */
export interface MirrorOption<Ref> {
  /** The account or EventKit source it lives in. */
  readonly group: string;
  readonly key: string;
  readonly label: string;
  readonly ref: Ref;
}

const accountLabel = (account: Account): string =>
  isAppleCalendarAccount(account)
    ? 'Apple Calendar'
    : isAppleRemindersAccount(account)
      ? 'Reminders'
      : account.email;

export const taskListRefOf = (
  list: TaskListInfo,
  account: Account,
): MirrorSourceRef | undefined => {
  if (isAppleRemindersAccount(account)) {
    return { kind: 'reminders', title: list.title };
  }
  return account.provider === 'google'
    ? { email: account.email, kind: 'googleTasks', listId: list.id, title: list.title }
    : undefined;
};

const sortedOptions = <Ref>(options: Array<MirrorOption<Ref>>): Array<MirrorOption<Ref>> =>
  options.sort((a, b) => a.group.localeCompare(b.group) || a.label.localeCompare(b.label));

/** Every calendar and list a mirror can read: all of them, hidden ones included. */
export const mirrorSourceOptions = (input: {
  readonly accounts: ReadonlyArray<Account>;
  readonly calendars: ReadonlyArray<CalendarInfo>;
  readonly taskLists: ReadonlyArray<TaskListInfo>;
}): ReadonlyArray<MirrorOption<MirrorSourceRef>> => {
  const options: Array<MirrorOption<MirrorSourceRef>> = [];
  for (const calendar of input.calendars) {
    const account = input.accounts.find((entry) => entry.id === calendar.accountId);
    const ref = account && portableCalendarRef(calendar, account);
    if (ref && account) {
      options.push({
        group: accountLabel(account),
        key: mirrorRefKey(ref),
        label: calendar.summary,
        ref,
      });
    }
  }
  for (const list of input.taskLists) {
    const account = input.accounts.find((entry) => entry.id === list.accountId);
    const ref = account && taskListRefOf(list, account);
    if (ref && account) {
      options.push({
        group: accountLabel(account),
        key: mirrorRefKey(ref),
        label: list.title,
        ref,
      });
    }
  }
  return sortedOptions(options);
};

/**
 * Every calendar a mirror can write into: writable ones that are not a
 * source of this draft and not another mirror's destination.
 */
export const mirrorDestinationOptions = (input: {
  readonly accounts: ReadonlyArray<Account>;
  readonly calendars: ReadonlyArray<CalendarInfo>;
  readonly draft: Pick<MirrorDraft, 'id' | 'sources'>;
  readonly mirrors: ReadonlyArray<MirrorView>;
}): ReadonlyArray<MirrorOption<MirrorCalendarRef>> => {
  const taken = new Set(
    input.mirrors
      .filter((mirror) => mirror.definition.id !== input.draft.id)
      .map((mirror) => mirrorRefKey(mirror.definition.destination)),
  );
  const sources = new Set(input.draft.sources.map(mirrorRefKey));
  const options: Array<MirrorOption<MirrorCalendarRef>> = [];
  for (const calendar of input.calendars) {
    const account = input.accounts.find((entry) => entry.id === calendar.accountId);
    const ref =
      account && isCalendarWritable(calendar) ? portableCalendarRef(calendar, account) : undefined;
    if (!ref || !account) {
      continue;
    }
    const key = mirrorRefKey(ref);
    if (!taken.has(key) && !sources.has(key)) {
      options.push({ group: accountLabel(account), key, label: calendar.summary, ref });
    }
  }
  return sortedOptions(options);
};

/** The Google accounts a new destination calendar can be made in. */
export const googleAccountsForNewCalendar = (
  accounts: ReadonlyArray<Account>,
): ReadonlyArray<Account> =>
  accounts.filter((account) => account.provider === 'google' && account.status === 'ok');

export const newMirrorDraft = (timeZone: string): MirrorDraft => ({
  busyLabel: MIRROR_DEFAULT_BUSY_LABEL,
  destination: undefined,
  ...MIRROR_PRESETS.titleLocation,
  // Web Crypto: native in Node and Electron, polyfilled from expo-crypto on Hermes.
  id: crypto.randomUUID(),
  monthsAhead: MIRROR_DEFAULT_MONTHS,
  name: '',
  sources: [],
  timeZone,
});

export const draftOf = (definition: MirrorDefinition): MirrorDraft => {
  const { updatedAt: _stamp, ...rest } = definition;
  return rest;
};

/** Why the draft cannot be saved yet, or undefined. */
export const mirrorDraftIssue = (draft: MirrorDraft): string | undefined => {
  if (draft.name.trim() === '') {
    return 'Give the mirror a name.';
  }
  if (draft.sources.length === 0) {
    return 'Pick at least one calendar or list to copy from.';
  }
  if (draft.destination === undefined) {
    return 'Pick the calendar to copy into.';
  }
  if (draft.busyLabel.trim() === '') {
    return 'The busy label cannot be empty.';
  }
  return undefined;
};

/** The draft as a definition, stamped for Save (the backend keeps an unchanged revision). */
export const definitionOf = (
  draft: MirrorDraft,
  updatedAt: number,
): MirrorDefinition | undefined =>
  draft.destination === undefined
    ? undefined
    : { ...draft, destination: draft.destination, updatedAt };

/**
 * A ref key as a test id: Maestro reads an id as a regular expression, so
 * `|`, `.` and `@` in the raw key would never match.
 */
export const refSlug = (key: string): string => key.replaceAll(/[^a-z0-9]+/gi, '-');

export const refLabel = (ref: MirrorSourceRef): string => {
  switch (ref.kind) {
    case 'apple':
      return ref.title;
    case 'google':
      return ref.title ?? ref.calendarId;
    case 'googleTasks':
      return ref.title ?? ref.listId;
    case 'reminders':
      return ref.title;
  }
};

/** Adds or drops a source. */
export const withSourceToggled = (draft: MirrorDraft, ref: MirrorSourceRef): MirrorDraft => {
  const key = mirrorRefKey(ref);
  const present = draft.sources.some((source) => mirrorRefKey(source) === key);
  return {
    ...draft,
    sources: present
      ? draft.sources.filter((source) => mirrorRefKey(source) !== key)
      : [...draft.sources, ref],
  };
};

export const hasSource = (draft: Pick<MirrorDraft, 'sources'>, ref: MirrorSourceRef): boolean =>
  draft.sources.some((source) => mirrorRefKey(source) === mirrorRefKey(ref));
