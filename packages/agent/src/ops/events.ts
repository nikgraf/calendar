import { type AttendeeInput, type EventDraft, isCalendarWritable } from '@calendar/core';
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
import { type Directory, resolveCalendar, resolveEvent } from '../resolve.ts';
import {
  calendarLine,
  changeLine,
  describeWhen,
  guestsLine,
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
    const resolved = yield* resolveEvent(directory, input.ref);
    const { granted, record, ref, series } = resolved;
    const { calendar } = granted;
    const scope = input.scope ?? 'instance';
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
    // Everyone a write reaches: the event's guests, the series' guests for
    // an occurrence, and whoever the new list adds.
    const own = granted.account?.email;
    const current = new Set(
      [...otherGuests(record, own), ...(series ? otherGuests(series, own) : [])].map((guest) =>
        guest.email.toLowerCase(),
      ),
    );
    const next = attendees?.map((guest) => guest.email.toLowerCase());
    const added = (attendees ?? []).filter((guest) => !current.has(guest.email.toLowerCase()));
    const removed = next === undefined ? [] : [...current].filter((email) => !next.includes(email));
    const plan: WritePlan<EventMutations> = {
      decision: decideWrite({
        guests: policy.guests,
        level: granted.level,
        providerWritable: isCalendarWritable(calendar),
        touchesGuests: current.size > 0 || (attendees?.length ?? 0) > 0,
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
      summary: summarize(titled('Update', 'event', record.title), [
        calendarLine(calendar.summary, directory.accountLabel(calendar.accountId)),
        ref.kind === 'occurrence' && scopeLine(scope),
        title !== undefined && title !== record.title && changeLine('Title', record.title, title),
        times.value !== undefined &&
          `When: ${describeWhen(base, directory.timeZone)} → ${describeWhen(times.value, directory.timeZone)}`,
        times.value === undefined && `When: ${describeWhen(base, directory.timeZone)}`,
        input.location !== undefined &&
          changeLine('Location', record.location, input.location.trim()),
        input.description !== undefined &&
          changeLine('Notes', record.description, input.description),
        // New guests receive the whole event: show what they will read even
        // where this request does not change it.
        added.length > 0 &&
          input.location === undefined &&
          !!record.location &&
          textLine('Location', record.location),
        added.length > 0 &&
          input.description === undefined &&
          !!record.description &&
          textLine('Notes', record.description),
        added.length > 0 && `Adds ${guestsLine(added.map((guest) => guest.email))}`,
        removed.length > 0 && `Removes ${guestsLine(removed)}`,
        current.size > 0 &&
          `${current.size} guest${current.size === 1 ? '' : 's'} on this event will be notified`,
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
    const { base, granted, record, ref, series } = yield* resolveEvent(directory, input.ref);
    const { calendar } = granted;
    const scope = input.scope ?? 'instance';
    const own = granted.account?.email;
    const guests = new Set(
      [...otherGuests(record, own), ...(series ? otherGuests(series, own) : [])].map((guest) =>
        guest.email.toLowerCase(),
      ),
    );
    const plan: WritePlan<EventMutations> = {
      decision: decideWrite({
        guests: policy.guests,
        level: granted.level,
        providerWritable: isCalendarWritable(calendar),
        touchesGuests: guests.size > 0,
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
      summary: summarize(titled('Delete', 'event', record.title), [
        calendarLine(calendar.summary, directory.accountLabel(calendar.accountId)),
        `When: ${describeWhen(base, directory.timeZone)}`,
        ref.kind === 'occurrence' && scopeLine(scope),
        guests.size > 0 &&
          `${guests.size} guest${guests.size === 1 ? '' : 's'} on this event will see it cancelled`,
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
