import {
  type AttendeeInput,
  type EventDraft,
  type EventRecord,
  isAppleCalendarAccount,
  isCalendarWritable,
  type RecurringScope,
} from '@calendar/core';
import { EventMutations, type UpdateEventParams } from '@calendar/sync';
import { Effect } from 'effect';
import type { ToolInput } from '../contract.ts';
import { otherGuests, toEventDto } from '../dto.ts';
import { type AgentPolicy, decideWrite } from '../policy.ts';
import {
  invalid,
  MAX_GUESTS,
  MAX_LOCATION,
  MAX_NOTES,
  MAX_RECURRENCE_LINE,
  MAX_RECURRENCE_LINES,
  MAX_TITLE,
  within,
} from './limits.ts';
import { type Directory, resolveCalendar, type ResolvedEvent, resolveEvent } from '../resolve.ts';
import {
  calendarLine,
  changeLine,
  describeWhen,
  guestsLine,
  peopleLine,
  scopeLine,
  summarize,
  textLine,
  titled,
} from '../summary.ts';
import { createTimes, type EventTimes, updateTimes } from '../times.ts';
import type { WritePlan } from './plan.ts';

// Printable ASCII only: a look-alike "＠" or an invisible character must
// not make one address read as another in the approval dialog.
const EMAIL =
  /^[\u0021-\u003F\u0041-\u007E]+@[\u0021-\u003F\u0041-\u007E]+\.[\u0021-\u003F\u0041-\u007E]+$/u;
// One RFC 5545 line, start to end: no line break may smuggle a second one in.
const RECURRENCE_LINE = /^(?:RRULE|EXRULE|RDATE|EXDATE)[:;][\u0020-\u007E]*$/u;

/** Trimmed, de-duplicated guests; fails on anything that is not an address. */
const guestList = (
  attendees: ReadonlyArray<{ readonly email: string; readonly name?: string | undefined }>,
) =>
  Effect.gen(function* () {
    if (attendees.length > MAX_GUESTS) {
      return yield* invalid(`At most ${MAX_GUESTS} guests per event.`);
    }
    const seen = new Map<string, AttendeeInput>();
    for (const attendee of attendees) {
      yield* within('A guest name', attendee.name, MAX_TITLE);
      const email = attendee.email.trim();
      if (!EMAIL.test(email)) {
        return yield* invalid(`"${attendee.email}" is not an email address.`);
      }
      const name = attendee.name?.trim();
      seen.set(email.toLowerCase(), { ...(name ? { displayName: name } : {}), email });
    }
    return [...seen.values()];
  });

/** The stored (exclusive-end) time fields of a draft or a change set. */
const timeFields = (times: EventTimes) =>
  times.isAllDay
    ? {
        endDate: times.endDate,
        endUtc: times.endUtc,
        startDate: times.startDate,
        startUtc: times.startUtc,
      }
    : { endUtc: times.endUtc, startUtc: times.startUtc };

/**
 * What a write with this scope really lands on, and everyone it reaches.
 *
 * `written` is the event whose text and guest list the mutation works
 * from — and so what a summary must show: the occurrence itself for a
 * change to one occurrence, but the series master for a series-wide or
 * "following" change (which ignores what a moved occurrence says about
 * itself). `guests` are the people who get mail: the written event's, the
 * master's whenever the series is touched, and those of every other
 * exception the scope rewrites or cancels.
 */
const reachOf = (
  resolved: ResolvedEvent,
  scope: RecurringScope,
  ownEmail: string | undefined,
): { readonly guests: ReadonlyArray<string>; readonly written: EventRecord } => {
  const { exceptions, record, ref, series } = resolved;
  if (ref.kind === 'event' || scope === 'instance' || !series) {
    return {
      guests: [
        ...new Set(otherGuests(record, ownEmail).map((guest) => guest.email.toLowerCase())),
      ].sort(),
      written: record,
    };
  }
  // EventKit applies "this and following" from the occurrence itself;
  // everything else works from the master.
  const written =
    scope === 'following' && isAppleCalendarAccount({ id: ref.accountId }) ? record : series;
  const affected = (exceptions ?? []).filter(
    (exception) =>
      scope === 'series' ||
      (exception.originalStartUtc ?? exception.startUtc) >= ref.originalStartUtc,
  );
  return {
    guests: [
      ...new Set(
        [written, series, ...affected]
          .flatMap((event) => otherGuests(event, ownEmail))
          .map((guest) => guest.email.toLowerCase()),
      ),
    ].sort(),
    written,
  };
};

export const planCreateEvent = (
  policy: AgentPolicy,
  directory: Directory,
  input: ToolInput<'create_event'>,
) =>
  Effect.gen(function* () {
    const granted = yield* resolveCalendar(directory, input.calendar);
    const title = input.title.trim();
    if (title === '') {
      return yield* invalid('title must not be empty.');
    }
    yield* within('title', title, MAX_TITLE);
    yield* within('description', input.description, MAX_NOTES);
    yield* within('location', input.location, MAX_LOCATION);
    const times = createTimes(input, directory.timeZone);
    if (!times.ok) {
      return yield* invalid(times.message);
    }
    const attendees = yield* guestList(input.attendees ?? []);
    const recurrence = input.recurrence ?? [];
    if (
      recurrence.length > MAX_RECURRENCE_LINES ||
      recurrence.some((line) => line.length > MAX_RECURRENCE_LINE || !RECURRENCE_LINE.test(line))
    ) {
      return yield* invalid('recurrence lines must be RFC 5545 lines such as RRULE:FREQ=WEEKLY.');
    }
    const { calendar } = granted;
    const draft: EventDraft = {
      accountId: calendar.accountId,
      ...(attendees.length > 0 ? { attendees } : {}),
      calendarId: calendar.id,
      ...(input.description ? { description: input.description } : {}),
      isAllDay: times.value.isAllDay,
      ...(input.location?.trim() ? { location: input.location.trim() } : {}),
      ...(recurrence.length > 0 ? { recurrence } : {}),
      ...(times.value.isAllDay ? {} : { startTimeZone: times.value.startTimeZone }),
      ...timeFields(times.value),
      title,
    };
    const plan: WritePlan<EventMutations> = {
      decision: decideWrite({
        guests: policy.guests,
        level: granted.level,
        providerWritable: isCalendarWritable(calendar),
        touchesGuests: attendees.length > 0,
      }),
      run: Effect.gen(function* () {
        const record = yield* (yield* EventMutations).createEvent(draft);
        return { event: toEventDto(record, directory.timeZone), status: 'done' as const };
      }),
      summary: summarize(titled('Create', 'event', title), [
        calendarLine(calendar.summary, directory.accountLabel(calendar.accountId)),
        `When: ${describeWhen(times.value, directory.timeZone)}`,
        recurrence.length > 0 && `Repeats: ${recurrence.join(' ')}`,
        attendees.length > 0 &&
          `${guestsLine(attendees.map((guest) => guest.email))} — they will be emailed an invitation`,
        draft.location !== undefined && textLine('Location', draft.location),
        draft.description !== undefined && textLine('Notes', draft.description),
      ]),
      what: 'Calendar',
    };
    return plan;
  });

export const planUpdateEvent = (
  policy: AgentPolicy,
  directory: Directory,
  input: ToolInput<'update_event'>,
) =>
  Effect.gen(function* () {
    const scope = input.scope ?? 'instance';
    const resolved = yield* resolveEvent(directory, input.ref, {
      wholeSeries: scope !== 'instance',
    });
    const { granted, ref } = resolved;
    const { calendar } = granted;
    // A change to one occurrence starts from that occurrence (its own
    // times when it was moved before). A series-wide or "following" change
    // starts from the occurrence's slot in the series: the mutation shifts
    // the series by the distance from that slot, so a moved exception's
    // own times would drag every other occurrence along.
    const base =
      ref.kind === 'occurrence' && scope !== 'instance'
        ? (resolved.slotBase ?? resolved.base)
        : resolved.base;
    const times = updateTimes(input, base, directory.timeZone);
    if (!times.ok) {
      return yield* invalid(times.message);
    }
    const title = input.title?.trim();
    if (title === '') {
      return yield* invalid('title must not be empty.');
    }
    yield* within('title', title, MAX_TITLE);
    yield* within('description', input.description, MAX_NOTES);
    yield* within('location', input.location, MAX_LOCATION);
    const attendees = input.attendees === undefined ? undefined : yield* guestList(input.attendees);
    if (
      times.value === undefined &&
      title === undefined &&
      attendees === undefined &&
      input.description === undefined &&
      input.location === undefined
    ) {
      return yield* invalid('Nothing to change: send at least one field besides ref.');
    }
    if (ref.kind === 'occurrence' && times.value && times.value.isAllDay !== base.isAllDay) {
      return yield* invalid(
        'An occurrence of a repeating event cannot switch between timed and all-day.',
      );
    }
    if (ref.kind === 'occurrence' && times.value?.isAllDay && scope !== 'instance') {
      // The series mutation only moves timed series; saying "done" for a
      // date change it drops would be a lie.
      return yield* invalid(
        'An all-day repeating event can only be moved one occurrence at a time (scope "instance"); move the whole series in Solunivo.',
      );
    }
    const changes: UpdateEventParams['changes'] = {
      ...(attendees === undefined ? {} : { attendees }),
      ...(input.description === undefined ? {} : { description: input.description }),
      ...(input.location === undefined ? {} : { location: input.location.trim() }),
      ...(times.value === undefined ? {} : timeFields(times.value)),
      ...(times.value === undefined || ref.kind === 'occurrence'
        ? {}
        : { isAllDay: times.value.isAllDay }),
      ...(title === undefined ? {} : { title }),
    };
    // `written` is what the mutation merges into; `reached` is who gets mail.
    const { guests: reached, written } = reachOf(resolved, scope, granted.account?.email);
    const onWritten = new Set(
      otherGuests(written, granted.account?.email).map((guest) => guest.email.toLowerCase()),
    );
    const next = attendees?.map((guest) => guest.email.toLowerCase());
    const added = (attendees ?? []).filter((guest) => !onWritten.has(guest.email.toLowerCase()));
    const removed =
      next === undefined ? [] : [...onWritten].filter((email) => !next.includes(email)).sort();
    const plan: WritePlan<EventMutations> = {
      decision: decideWrite({
        guests: policy.guests,
        level: granted.level,
        providerWritable: isCalendarWritable(calendar),
        touchesGuests: reached.length > 0 || (attendees?.length ?? 0) > 0,
      }),
      run: Effect.gen(function* () {
        const mutations = yield* EventMutations;
        yield* ref.kind === 'event'
          ? mutations.updateEvent({
              accountId: ref.accountId,
              calendarId: ref.calendarId,
              changes,
              eventId: ref.eventId,
            })
          : mutations.updateRecurring({
              accountId: ref.accountId,
              calendarId: ref.calendarId,
              changes,
              masterId: ref.masterId,
              originalStartUtc: ref.originalStartUtc,
              scope,
            });
        return { status: 'done' as const };
      }),
      // Built from the event that is written, not the one that was clicked:
      // for a series-wide change those differ when the occurrence was edited
      // on its own, and the user must see the text new guests will get.
      summary: summarize(titled('Update', 'event', written.title), [
        calendarLine(calendar.summary, directory.accountLabel(calendar.accountId)),
        ref.kind === 'occurrence' && scopeLine(scope),
        title !== undefined && title !== written.title && changeLine('Title', written.title, title),
        times.value !== undefined &&
          `When: ${describeWhen(base, directory.timeZone)} → ${describeWhen(times.value, directory.timeZone)}`,
        times.value === undefined && `When: ${describeWhen(base, directory.timeZone)}`,
        input.location !== undefined &&
          changeLine('Location', written.location, input.location.trim()),
        input.description !== undefined &&
          changeLine('Notes', written.description, input.description),
        // New guests receive the whole event: show what they will read even
        // where this request does not change it.
        added.length > 0 &&
          input.location === undefined &&
          !!written.location &&
          textLine('Location', written.location),
        added.length > 0 &&
          input.description === undefined &&
          !!written.description &&
          textLine('Notes', written.description),
        added.length > 0 && `Adds ${guestsLine(added.map((guest) => guest.email))}`,
        removed.length > 0 && `Removes ${guestsLine(removed)}`,
        // By address: swapping one guest for another must change the summary.
        reached.length > 0 && peopleLine('Guests who will be notified', reached),
      ]),
      what: 'Event',
    };
    return plan;
  });

export const planDeleteEvent = (
  policy: AgentPolicy,
  directory: Directory,
  input: ToolInput<'delete_event'>,
) =>
  Effect.gen(function* () {
    const scope = input.scope ?? 'instance';
    const resolved = yield* resolveEvent(directory, input.ref, {
      wholeSeries: scope !== 'instance',
    });
    const { base, granted, ref } = resolved;
    const { calendar } = granted;
    const { guests, written } = reachOf(resolved, scope, granted.account?.email);
    const plan: WritePlan<EventMutations> = {
      decision: decideWrite({
        guests: policy.guests,
        level: granted.level,
        providerWritable: isCalendarWritable(calendar),
        touchesGuests: guests.length > 0,
      }),
      run: Effect.gen(function* () {
        const mutations = yield* EventMutations;
        yield* ref.kind === 'event'
          ? mutations.deleteEvent({
              accountId: ref.accountId,
              calendarId: ref.calendarId,
              eventId: ref.eventId,
            })
          : mutations.deleteRecurring({
              accountId: ref.accountId,
              calendarId: ref.calendarId,
              masterId: ref.masterId,
              originalStartUtc: ref.originalStartUtc,
              scope,
            });
        return { status: 'done' as const };
      }),
      summary: summarize(titled('Delete', 'event', written.title), [
        calendarLine(calendar.summary, directory.accountLabel(calendar.accountId)),
        `When: ${describeWhen(base, directory.timeZone)}`,
        ref.kind === 'occurrence' && scopeLine(scope),
        guests.length > 0 && peopleLine('Guests who will see it cancelled', guests),
      ]),
      what: 'Event',
    };
    return plan;
  });

const RESPONSE_LABEL = { accepted: 'Accept', declined: 'Decline', tentative: 'Maybe' } as const;

export const planRespondToEvent = (
  policy: AgentPolicy,
  directory: Directory,
  input: ToolInput<'respond_to_event'>,
) =>
  Effect.gen(function* () {
    const { base, granted, record, ref } = yield* resolveEvent(directory, input.ref);
    const { calendar } = granted;
    const plan: WritePlan<EventMutations> = {
      // An RSVP changes only the user's own answer: the calendar level
      // decides, the guests capability is not involved.
      decision: decideWrite({
        guests: policy.guests,
        level: granted.level,
        providerWritable: true,
        touchesGuests: false,
      }),
      run: Effect.gen(function* () {
        yield* (yield* EventMutations).respondToEvent({
          accountId: ref.accountId,
          calendarId: ref.calendarId,
          // RSVPs are series-wide: an occurrence answers for its master.
          eventId: ref.kind === 'event' ? ref.eventId : ref.masterId,
          response: input.response,
        });
        return { status: 'done' as const };
      }),
      summary: summarize(titled(RESPONSE_LABEL[input.response], 'invitation', record.title), [
        calendarLine(calendar.summary, directory.accountLabel(calendar.accountId)),
        `When: ${describeWhen(base, directory.timeZone)}`,
        record.organizerEmail !== undefined && `Organizer: ${record.organizerEmail}`,
        ref.kind === 'occurrence' && 'Applies to: Every occurrence of the series',
      ]),
      what: 'Event',
    };
    return plan;
  });
