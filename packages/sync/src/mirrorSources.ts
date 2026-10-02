import {
  type AppleCalendarClientShape,
  type AppleCalendarError,
  type AppleEventJson,
} from '@calendar/apple-calendar';
import {
  APPLE_REMINDERS_ACCOUNT_ID,
  assembleWindow,
  googleEventMirrorItem,
  isMirrorUrl,
  meetingUrl,
  type MirrorDefinition,
  type MirrorItem,
  type MirrorWindow,
  taskMirrorItem,
  Temporal,
  toZonedDateTime,
} from '@calendar/core';
import { EventRepo, TaskRepo } from '@calendar/db';
import { Effect } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';
import type { ResolvedSource } from './mirrorResolve.ts';

/**
 * Everything a mirror's sources hold around its window, as items. Read
 * with the source queries, never through `loadEventsInRange`: that one
 * follows this device's show/hide toggles, and two devices must see the
 * same sources whatever each of them has hidden.
 */

/**
 * An EventKit event as a mirror item. Its identity is the external
 * identifier (the same on every device) plus, for an occurrence of a
 * series, its slot. An all-day or floating slot is a wall-clock moment,
 * so it is named by its date and time in the zone this device reads it
 * in — which is the same text on every device, where the instant is not.
 */
export const appleEventMirrorItem = (
  event: AppleEventJson,
  options: { readonly deviceTimeZone: string; readonly refKey: string },
): MirrorItem | undefined => {
  if (event.externalId === undefined) {
    return undefined;
  }
  const slot = event.occurrenceStartUtc;
  const occurrence =
    slot === undefined
      ? ''
      : event.isAllDay || event.timeZone === undefined
        ? `|${toZonedDateTime(slot, options.deviceTimeZone).toPlainDateTime().toString()}`
        : `|${String(slot)}`;
  return {
    allDay: event.isAllDay,
    // EventKit only says who the guests are, and the user's own answer among them.
    declined: (event.attendees ?? []).some(
      (attendee) => attendee.isSelf && attendee.status === 'declined',
    ),
    description: event.description,
    done: false,
    endDate: event.endDate,
    endUtc: event.endUtc,
    // The bridge does not read availability: an Apple event always blocks time.
    free: false,
    key: `a|${options.refKey}|${event.externalId}${occurrence}`,
    // The URL field counts only when it is a meeting link, like the views read it.
    link: meetingUrl({
      description: event.description,
      location: `${event.location ?? ''} ${event.url ?? ''}`,
    }),
    location: event.location,
    private: false,
    startDate: event.startDate,
    startUtc: event.startUtc,
    title: event.title,
  };
};

/** A day's margin on both sides: the window is in the mirror's zone, the stores index in UTC. */
const DAY_MS = 24 * 60 * 60 * 1000;

export const loadMirrorItems = (
  definition: MirrorDefinition,
  sources: ReadonlyArray<ResolvedSource>,
  window: MirrorWindow,
  apple: AppleCalendarClientShape,
): Effect.Effect<ReadonlyArray<MirrorItem>, AppleCalendarError | SqlError, EventRepo | TaskRepo> =>
  Effect.gen(function* () {
    const events = yield* EventRepo;
    const tasks = yield* TaskRepo;
    const items: Array<MirrorItem> = [];
    const start = window.startUtc - DAY_MS;
    const end = window.endUtc + DAY_MS;

    // Google calendars, one query per account.
    const googleCalendars = new Map<string, { email: string; ids: Array<string> }>();
    for (const source of sources) {
      if (source.provider === 'google') {
        const entry = googleCalendars.get(source.account.id) ?? {
          email: source.account.email,
          ids: [],
        };
        entry.ids.push(source.calendar.id);
        googleCalendars.set(source.account.id, entry);
      }
    }
    for (const [accountId, { email, ids }] of googleCalendars) {
      const stored = yield* events.getSourceWindow(accountId, ids, start, end);
      const skipped: Array<string> = [];
      for (const event of assembleWindow(stored, start, end, (master) => skipped.push(master.id))) {
        items.push(googleEventMirrorItem(event, email));
      }
      if (skipped.length > 0) {
        // Ids only: a log line must never carry a title.
        yield* Effect.logWarning('mirror: recurring masters skipped', { count: skipped.length });
      }
    }

    // Apple calendars: EventKit answers every calendar in one range read.
    const appleCalendars = new Map<string, string>();
    for (const source of sources) {
      if (source.provider === 'apple') {
        appleCalendars.set(source.calendar.id, source.refKey);
      }
    }
    if (appleCalendars.size > 0) {
      const deviceTimeZone = Temporal.Now.timeZoneId();
      for (const event of yield* apple.events({ endUtc: end, startUtc: start })) {
        const refKey = appleCalendars.get(event.calendarId);
        // Another mirror's copy is never a source.
        if (refKey === undefined || event.status === 'cancelled' || isMirrorUrl(event.url)) {
          continue;
        }
        const item = appleEventMirrorItem(event, { deviceTimeZone, refKey });
        if (item !== undefined) {
          items.push(item);
        }
      }
    }

    // Task lists. A task with a temporary id has not reached Google yet;
    // its real id (and so its copy's identity) is still to come.
    const taskOptions = { timeZone: definition.timeZone, today: window.today };
    for (const source of sources) {
      if (source.provider === 'googleTasks') {
        for (const task of yield* tasks.getMirrorSource(source.account.id, [source.list.id])) {
          if (!task.id.startsWith('local-')) {
            items.push(
              taskMirrorItem(task, { ...taskOptions, key: `t|${task.listId}|${task.id}` }),
            );
          }
        }
      } else if (source.provider === 'reminders') {
        for (const task of yield* tasks.getMirrorSource(APPLE_REMINDERS_ACCOUNT_ID, [
          source.list.id,
        ])) {
          if (task.externalId !== undefined) {
            items.push(taskMirrorItem(task, { ...taskOptions, key: `r|${task.externalId}` }));
          }
        }
      }
    }
    return items;
  });
