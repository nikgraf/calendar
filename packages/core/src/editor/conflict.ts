import type { PendingOpSummary } from '../backend.ts';
import { UNTITLED_EVENT } from '../format.ts';
import { Temporal } from '../time/temporal.ts';
import type { EventRecord } from '../types.ts';

/** A queue entry a 412 parked, waiting for keep-mine / take-theirs. */
export type ParkedOpSummary = PendingOpSummary & {
  readonly conflict: NonNullable<PendingOpSummary['conflict']>;
};

export const isParkedOp = (op: PendingOpSummary): op is ParkedOpSummary =>
  op.conflict !== undefined;

/** One field that differs between the user's queued version and Google's. */
export interface ConflictChange {
  readonly label: 'Guests' | 'Location' | 'Notes' | 'Time' | 'Title';
  readonly mine: string;
  readonly theirs: string;
}

export interface ConflictDescription {
  /** Field-by-field differences; empty when there is nothing to compare. */
  readonly changes: ReadonlyArray<ConflictChange>;
  /** One sentence naming the event and what happened on Google. */
  readonly headline: string;
}

export interface ConflictInput {
  readonly conflict: {
    readonly mine?: EventRecord | undefined;
    readonly theirs: EventRecord | null;
  };
  readonly kind: string;
  readonly title?: string | undefined;
}

/** "Tue, Sep 23". */
export const plainDateLabel = (isoDate: string): string =>
  Temporal.PlainDate.from(isoDate).toLocaleString('en-US', {
    day: 'numeric',
    month: 'short',
    weekday: 'short',
  });

const clock = (value: Temporal.ZonedDateTime): string =>
  value.toPlainTime().toLocaleString('en-US', { hour: 'numeric', minute: '2-digit' });

const day = (value: Temporal.ZonedDateTime): string =>
  plainDateLabel(value.toPlainDate().toString());

/** "Tue, Sep 23, 9:00 AM – 10:30 AM" (timed) or "Tue, Sep 23 – Thu, Sep 25" (all-day). */
export const conflictTimeLabel = (event: EventRecord, timeZone: string): string => {
  if (event.isAllDay && event.startDate) {
    const lastDay = event.endDate
      ? Temporal.PlainDate.from(event.endDate).subtract({ days: 1 }).toString()
      : event.startDate;
    return lastDay > event.startDate
      ? `${plainDateLabel(event.startDate)} – ${plainDateLabel(lastDay)}`
      : `${plainDateLabel(event.startDate)} (all day)`;
  }
  const start = Temporal.Instant.fromEpochMilliseconds(event.startUtc).toZonedDateTimeISO(timeZone);
  const end = Temporal.Instant.fromEpochMilliseconds(event.endUtc).toZonedDateTimeISO(timeZone);
  const sameDay = Temporal.PlainDate.compare(start.toPlainDate(), end.toPlainDate()) === 0;
  return sameDay
    ? `${day(start)}, ${clock(start)} – ${clock(end)}`
    : `${day(start)}, ${clock(start)} – ${day(end)}, ${clock(end)}`;
};

const guestsLabel = (event: EventRecord): string => {
  const emails = (event.attendees ?? [])
    .filter((attendee) => !attendee.isResource && !attendee.isOrganizer)
    .map((attendee) => attendee.email);
  return emails.length === 0 ? 'none' : emails.join(', ');
};

/** "none" for an empty text field, so a cleared field reads as a change. */
export const orNone = (value: string | undefined): string =>
  value?.trim() ? value.trim() : 'none';

/**
 * The fields a user would recognize, as they are displayed: what the
 * conflict banner and the unsynced-changes diff compare, in this order.
 */
export const eventFieldPairs = (
  event: EventRecord,
  timeZone: string,
): ReadonlyArray<readonly [ConflictChange['label'], string]> => [
  ['Title', event.title || UNTITLED_EVENT],
  ['Time', conflictTimeLabel(event, timeZone)],
  ['Location', orNone(event.location)],
  ['Notes', orNone(event.description)],
  ['Guests', guestsLabel(event)],
];

/** The fields a user would recognize, compared as they are displayed. */
export const conflictChanges = (
  mine: EventRecord,
  theirs: EventRecord,
  timeZone: string,
): ReadonlyArray<ConflictChange> => {
  const theirPairs = eventFieldPairs(theirs, timeZone);
  return eventFieldPairs(mine, timeZone).flatMap(([label, left], index) => {
    const right = theirPairs[index]?.[1] ?? '';
    return left === right ? [] : [{ label, mine: left, theirs: right }];
  });
};

/**
 * What the conflict banner and the queue row say about a parked op. Only
 * `update` and `delete` send If-Match, so only they can park.
 */
export const describeConflict = (op: ConflictInput, timeZone: string): ConflictDescription => {
  const { mine, theirs } = op.conflict;
  const name = `“${op.title || theirs?.title || mine?.title || 'Untitled event'}”`;
  if (op.kind === 'delete') {
    return theirs
      ? { changes: [], headline: `${name} changed on Google before your delete reached it.` }
      : { changes: [], headline: `${name} is already gone on Google.` };
  }
  if (!theirs || theirs.status === 'cancelled') {
    return {
      changes: [],
      headline: `${name} was deleted on Google while your edit waited.`,
    };
  }
  return {
    changes: mine ? conflictChanges(mine, theirs, timeZone) : [],
    headline: `${name} changed on Google while your edit waited.`,
  };
};

/** Button labels, so both apps phrase the choice identically. */
export const conflictChoiceLabels = (
  op: ConflictInput,
): { readonly mine: string; readonly theirs: string } => {
  const theirsGone = !op.conflict.theirs || op.conflict.theirs.status === 'cancelled';
  if (op.kind === 'delete') {
    return { mine: 'Delete anyway', theirs: 'Keep theirs' };
  }
  return theirsGone
    ? { mine: 'Restore mine', theirs: 'Let it go' }
    : { mine: 'Keep mine', theirs: 'Take theirs' };
};
