import { Schema } from 'effect';

/**
 * What an agent may do with one calendar, weakest first:
 * - `none`: the calendar does not exist for the agent.
 * - `freeBusy`: busy blocks only — no titles, ids or details.
 * - `read`: full details.
 * - `ask`: reads like `read`; every write waits for the user's approval.
 * - `write`: reads and writes.
 */
export const CalendarLevel = Schema.Literals(['ask', 'freeBusy', 'none', 'read', 'write']);
export type CalendarLevel = typeof CalendarLevel.Type;

/** Task lists have no free/busy tier: a task is either readable or it is not. */
export const TaskListLevel = Schema.Literals(['ask', 'none', 'read', 'write']);
export type TaskListLevel = typeof TaskListLevel.Type;

/**
 * Writes that reach other people: creating, editing or deleting an event
 * that has (or gains) guests makes the provider email them. Separate from
 * the calendar level because it is the one write an agent can leak with.
 */
export const GuestsCapability = Schema.Literals(['allow', 'ask', 'off']);
export type GuestsCapability = typeof GuestsCapability.Type;

export const CalendarGrant = Schema.Struct({
  accountId: Schema.String,
  calendarId: Schema.String,
  level: CalendarLevel,
});
export type CalendarGrant = typeof CalendarGrant.Type;

export const TaskListGrant = Schema.Struct({
  accountId: Schema.String,
  level: TaskListLevel,
  taskListId: Schema.String,
});
export type TaskListGrant = typeof TaskListGrant.Type;

/**
 * One agent's grant. Device-local and managed only in the app's Settings
 * UI: it is never part of SettingsDocument, so editing the watched
 * settings file cannot widen it.
 */
export const AgentPolicy = Schema.Struct({
  /** Level of every calendar without an entry in `calendars`. */
  calendarDefault: CalendarLevel,
  calendars: Schema.Array(CalendarGrant),
  /** Whether `search_contacts` answers (the address book is personal data of third parties). */
  contacts: Schema.Boolean,
  guests: GuestsCapability,
  /** Level of every task list without an entry in `taskLists`. */
  taskListDefault: TaskListLevel,
  taskLists: Schema.Array(TaskListGrant),
});
export type AgentPolicy = typeof AgentPolicy.Type;

/** A new agent sees and touches nothing until the user grants it. */
export const EMPTY_POLICY: AgentPolicy = {
  calendarDefault: 'none',
  calendars: [],
  contacts: false,
  guests: 'off',
  taskListDefault: 'none',
  taskLists: [],
};

export const calendarLevel = (
  policy: AgentPolicy,
  target: { readonly accountId: string; readonly calendarId: string },
): CalendarLevel =>
  policy.calendars.find(
    (grant) => grant.accountId === target.accountId && grant.calendarId === target.calendarId,
  )?.level ?? policy.calendarDefault;

export const taskListLevel = (
  policy: AgentPolicy,
  target: { readonly accountId: string; readonly taskListId: string },
): TaskListLevel =>
  policy.taskLists.find(
    (grant) => grant.accountId === target.accountId && grant.taskListId === target.taskListId,
  )?.level ?? policy.taskListDefault;

/** Titles, ids and details are visible from `read` up. */
export const canSeeDetails = (level: CalendarLevel | TaskListLevel): boolean =>
  level === 'read' || level === 'ask' || level === 'write';

export type DeniedReason =
  /** The guests capability is off and the write would reach other people. */
  | 'guests'
  /** The grant stops at reading. */
  | 'level'
  /** The provider refuses writes to this calendar/list, whatever the grant. */
  | 'readOnly';

export type WriteDecision =
  | { readonly _tag: 'Allow' }
  | { readonly _tag: 'Ask' }
  | { readonly _tag: 'Denied'; readonly reason: DeniedReason }
  /** The target is invisible to the agent: answer exactly as if it did not exist. */
  | { readonly _tag: 'Hidden' };

/**
 * The one place a write is authorized. `providerWritable` is the
 * provider's own answer (a subscribed calendar stays read-only under any
 * grant); `touchesGuests` is whether the event has or gains guests.
 */
export const decideWrite = (input: {
  readonly guests: GuestsCapability;
  readonly level: CalendarLevel | TaskListLevel;
  readonly providerWritable: boolean;
  readonly touchesGuests: boolean;
}): WriteDecision => {
  if (input.level === 'none') {
    return { _tag: 'Hidden' };
  }
  if (input.level === 'freeBusy' || input.level === 'read') {
    return { _tag: 'Denied', reason: 'level' };
  }
  if (!input.providerWritable) {
    return { _tag: 'Denied', reason: 'readOnly' };
  }
  if (input.touchesGuests && input.guests === 'off') {
    return { _tag: 'Denied', reason: 'guests' };
  }
  if (input.level === 'ask' || (input.touchesGuests && input.guests === 'ask')) {
    return { _tag: 'Ask' };
  }
  return { _tag: 'Allow' };
};
