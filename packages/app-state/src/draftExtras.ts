import type { NotesChange, ReminderChange } from '@calendar/ai';
import {
  canonicalReminders,
  EventReminders,
  MAX_REMINDER_MINUTES,
  MAX_REMINDER_OVERRIDES,
  ReminderOverride,
  reminderLabel,
} from '@calendar/core';

/**
 * What a turn's words do to a draft's notes and notifications (read by
 * `@calendar/ai`'s `readExtras`), applied to the draft as the thread holds
 * it: the same rules for the thread, "Add all" and the bench.
 */

/** The notes after a change: a note added on a line of its own, the notes replaced, or none. */
export const applyNotesChange = (current: string, change: NotesChange): string => {
  switch (change.kind) {
    case 'add':
      return current.trim() === '' ? change.text : `${current.trimEnd()}\n${change.text}`;
    case 'clear':
      return '';
    case 'replace':
      return change.text;
  }
};

/** A change applied: the notifications now, and what of the change took effect. */
export interface AppliedReminders {
  /** The offsets added, in the order said. */
  readonly added: ReadonlyArray<number>;
  /** Offsets said that found no room (at most `MAX_REMINDER_OVERRIDES`). */
  readonly dropped: ReadonlyArray<number>;
  readonly reminders: EventReminders | undefined;
  /** The offsets taken off, in the order said. */
  readonly removed: ReadonlyArray<number>;
}

const popupMinutes = (overrides: ReadonlyArray<ReminderOverride>): ReadonlyArray<number> =>
  overrides.filter((override) => override.method === 'popup').map((override) => override.minutes);

/**
 * The notifications after a change, as the form holds them: popups at
 * the minutes said. A clearing leaves none ("none" — `useDefault:
 * false`, no overrides — is not the calendar's default); a removal takes
 * its offsets off the draft's own (a draft on the default has none to
 * take off); added ones join the draft's own, a draft on its calendar's
 * default giving the default up for them, as the form's own add does.
 * An offset already there, outside Google's range or beyond the five
 * the form allows is not added, and the change says so, rather than
 * one of the draft's own giving way. A change that takes no effect
 * leaves the draft as it was (the same object).
 */
export const applyReminderChange = (
  current: EventReminders | undefined,
  change: ReminderChange,
): AppliedReminders => {
  const own = current === undefined || current.useDefault ? [] : current.overrides;
  const base = change.clear ? [] : own;
  const removed = popupMinutes(base).filter((minutes) => change.remove.includes(minutes));
  const kept = base.filter(
    (override) => override.method !== 'popup' || !change.remove.includes(override.minutes),
  );
  const present = new Set(popupMinutes(kept));
  const valid = [...new Set(change.add)].filter(
    (minutes) =>
      Number.isInteger(minutes) &&
      minutes >= 0 &&
      minutes <= MAX_REMINDER_MINUTES &&
      !present.has(minutes),
  );
  const room = Math.max(MAX_REMINDER_OVERRIDES - kept.length, 0);
  const added = valid.slice(0, room);
  const dropped = valid.slice(room);
  if (!change.clear && added.length === 0 && removed.length === 0) {
    return { added, dropped, reminders: current, removed };
  }
  const reminders = canonicalReminders(
    new EventReminders({
      overrides: [
        ...kept,
        ...added.map((minutes) => new ReminderOverride({ method: 'popup', minutes })),
      ],
      useDefault: false,
    }),
  );
  return { added, dropped, reminders, removed };
};

/** "adds a note", "replaces the notes", "clears the notes": a turn's summary of its change. */
export const describeNotesChange = (change: NotesChange): string => {
  switch (change.kind) {
    case 'add':
      return 'adds a note';
    case 'clear':
      return 'clears the notes';
    case 'replace':
      return 'replaces the notes';
  }
};

const offsetLabel = (minutes: number, isAllDay: boolean): string => {
  const label = reminderLabel(minutes, isAllDay);
  return label.charAt(0).toLowerCase() + label.slice(1);
};

/**
 * What a change did, in words: "notifies 30 minutes before", "notifies
 * only 1 hour before" (the rest cleared), "no longer notifies 15 minutes
 * before", "no notifications", "at most 5 notifications" for an offset
 * that found no room. Nothing for a change that took no effect.
 */
export const describeReminderChange = (
  change: ReminderChange,
  applied: AppliedReminders,
  isAllDay: boolean,
): ReadonlyArray<string> => {
  const labels = (minutes: ReadonlyArray<number>) =>
    minutes.map((offset) => offsetLabel(offset, isAllDay)).join(', ');
  return [
    ...(change.clear && applied.added.length === 0 ? ['no notifications'] : []),
    ...(applied.added.length > 0
      ? [`${change.clear ? 'notifies only' : 'notifies'} ${labels(applied.added)}`]
      : []),
    ...(applied.removed.length > 0 ? [`no longer notifies ${labels(applied.removed)}`] : []),
    ...(applied.dropped.length > 0
      ? [`at most ${String(MAX_REMINDER_OVERRIDES)} notifications`]
      : []),
  ];
};
