import type { GoogleFixture } from '@calendar/sync/testing/googleFixture';

/** `days` from today as the RFC 3339 midnight-UTC `due` the Tasks API uses. */
const dueIn = (days: number): string => {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `${iso}T00:00:00.000Z`;
};

/**
 * The birthday flow's date: a week from today, or a week back late in the
 * month, so it shares today's month grid (the flow reaches it from there)
 * and no day-view flow meets the chip on today.
 */
const birthdayDate = (): { readonly day: number; readonly month: number } => {
  const date = new Date();
  date.setDate(date.getDate() + (date.getDate() <= 21 ? 7 : -7));
  return { day: date.getDate(), month: date.getMonth() + 1 };
};

/** An instant `weeks` from now at the given UTC hour, RFC 3339. */
const weeksOut = (weeks: number, hour: number): string => {
  const date = new Date(Date.now() + weeks * 7 * 24 * 60 * 60 * 1000);
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), hour),
  ).toISOString();
};

const pad = (n: number): string => String(n).padStart(2, '0');

/** Noon on this device's today, `weeks` weeks back (local calendar, DST-safe). */
const localNoonWeeksBack = (weeks: number): number => {
  const date = new Date();
  date.setDate(date.getDate() - 7 * weeks);
  date.setHours(12, 0, 0, 0);
  return date.getTime();
};

/**
 * An instant as Asia/Kolkata wall time, YYYY-MM-DDTHH:MM:00. Plain offset
 * math (UTC+05:30, no DST there): this runs on Hermes, whose Temporal and
 * Intl reject that zone name — the point of the flow.
 */
const kolkataWallTime = (ms: number): string => {
  const wall = new Date(ms + 5.5 * 60 * 60 * 1000);
  return `${wall.getUTCFullYear()}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}T${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:00`;
};

/** The zone-series flow's series starts three weeks back, at noon on this device. */
const KOLKATA_SERIES_START = localNoonWeeksBack(3);
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The signed-in Google account the Maestro flows see when Metro runs
 * with EXPO_PUBLIC_CALENDAR_GOOGLE=fixture (CI does): one writable
 * calendar for the create-event flow, one task list for the task lane,
 * task-convert and navigation flows, one contact birthday for the
 * birthday flow, three contacts for the quick-add flow's guests. A
 * second account is listed but signed out, as an import leaves one: its
 * row makes the Settings root scroll, as it does for anyone with two
 * accounts (Back to such a root froze iOS 26 while it had a large title),
 * and the header's account button carries its sign-in dot.
 * Served by the in-process fake API; nothing here ever reaches Google.
 */
export const googleFixture: GoogleFixture = {
  accounts: [
    {
      contactsEnabled: true,
      email: 'fixture@solunivo.test',
      id: 'fixture-google',
      tasksEnabled: true,
    },
    {
      email: 'imported@example.com',
      id: 'fixture-google-signed-out',
      signedOut: true,
      tasksEnabled: false,
    },
  ],
  calendars: [
    {
      accessRole: 'owner',
      backgroundColor: '#4285f4',
      id: 'mock-calendar',
      primary: true,
      summary: 'Mock Calendar',
    },
    // The mirror flow's destination: a second writable calendar.
    {
      accessRole: 'owner',
      backgroundColor: '#0b8043',
      id: 'mock-shared',
      summary: 'Mock Shared',
    },
  ],
  // One event the mirror flow copies, weeks out so no day-view flow meets
  // it; one weeks back at a place with coordinates, the quick-add flow's
  // past place (a dictated "Cafe Zentral" is found among past places by
  // sound, with no MapKit in CI's bundle).
  events: {
    'mock-calendar': [
      {
        end: { dateTime: weeksOut(5, 11) },
        id: 'fixture-planning',
        location: 'Room 4',
        start: { dateTime: weeksOut(5, 10) },
        status: 'confirmed',
        summary: 'Fixture planning',
      },
      {
        end: { dateTime: weeksOut(-3, 10) },
        extendedProperties: {
          private: {
            'solunivo.geo': '48.2105,16.3655',
            'solunivo.geoName': 'Café Central',
            'solunivo.geoSource': 'Café Central',
          },
        },
        id: 'fixture-coffee',
        location: 'Café Central',
        start: { dateTime: weeksOut(-3, 9) },
        status: 'confirmed',
        summary: 'Fixture coffee',
      },
    ],
    // The zone-series flow's event: weekly in Asia/Kolkata, which Hermes
    // rejects (it takes Asia/Calcutta), with an EXDATE in that zone too.
    // Anchored to noon on this device's today, three weeks back: Kolkata
    // keeps no DST, so this week's occurrence is around noon on the
    // simulator's today whatever its zone (a UTC anchor missed it where
    // the local date differs). Weekly, not daily: the day pager lays out
    // the neighbouring days off-screen, and a copy there is the element
    // Maestro picks first. In the mirror flow's destination, so nothing
    // mirrors it.
    'mock-shared': [
      {
        end: {
          dateTime: `${kolkataWallTime(KOLKATA_SERIES_START + 30 * 60 * 1000)}+05:30`,
          timeZone: 'Asia/Kolkata',
        },
        id: 'fixture-kolkata',
        recurrence: [
          'RRULE:FREQ=WEEKLY',
          // The second occurrence, a week after the start.
          `EXDATE;TZID=Asia/Kolkata:${kolkataWallTime(KOLKATA_SERIES_START + WEEK_MS).replaceAll(/[-:]/g, '')}`,
        ],
        start: {
          dateTime: `${kolkataWallTime(KOLKATA_SERIES_START)}+05:30`,
          timeZone: 'Asia/Kolkata',
        },
        status: 'confirmed',
        summary: 'Kolkata series',
      },
    ],
  },
  // The birthday-override flow's person. No email, so the invitee
  // typeahead never offers them.
  people: [
    {
      birthdays: [{ date: birthdayDate() }],
      names: [{ displayName: 'Birthday Fixture' }],
      resourceName: 'people/fixture-birthday',
    },
    // The quick-add flow's guests: "Anna Lee" is one contact, "Tom" two.
    // No address starts with "b", so flow 03's typed "bob@…" gets no row.
    {
      emailAddresses: [{ value: 'anna@example.com' }],
      names: [{ displayName: 'Anna Lee' }],
      resourceName: 'people/fixture-anna-lee',
    },
    {
      emailAddresses: [{ value: 'tlee@example.com' }],
      names: [{ displayName: 'Tom Lee' }],
      resourceName: 'people/fixture-tom-lee',
    },
    {
      emailAddresses: [{ value: 'tom.wright@example.com' }],
      names: [{ displayName: 'Tom Wright' }],
      resourceName: 'people/fixture-tom-wright',
    },
  ],
  taskLists: [{ id: 'mock-list', title: 'Mock Tasks' }],
  tasks: {
    'mock-list': [
      {
        due: dueIn(0),
        id: 'task-fixture',
        status: 'needsAction',
        title: 'Fixture task',
        updated: '2026-01-01T00:00:00.000Z',
      },
      // Today's backlog: two late tasks and two undated ones, each pair
      // folded into one chip on today's column (flow 27).
      {
        due: dueIn(-2),
        id: 'task-late-bike',
        status: 'needsAction',
        title: 'Return the rental bike',
        updated: '2026-01-01T00:00:00.000Z',
      },
      {
        due: dueIn(-5),
        id: 'task-late-form',
        status: 'needsAction',
        title: 'Sign the school form',
        updated: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'task-loose-receipts',
        status: 'needsAction',
        title: 'Sort the receipts',
        updated: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'task-loose-dinner',
        status: 'needsAction',
        title: 'Plan a birthday dinner',
        updated: '2026-01-01T00:00:00.000Z',
      },
      // The navigation flow's parent and subtask: three weeks out, so they
      // sit in the Tasks tab's "Upcoming" and on no day a timeline flow visits.
      // The subtask's title sorts after its parent's: outdented, it is the
      // row right below it, so Indent nests it there again.
      {
        due: dueIn(21),
        id: 'task-offsite',
        status: 'needsAction',
        title: 'Plan the offsite',
        updated: '2026-01-01T00:00:00.000Z',
      },
      {
        due: dueIn(21),
        id: 'task-room',
        parent: 'task-offsite',
        position: '00000000000000000000',
        status: 'needsAction',
        title: 'Reserve the room',
        updated: '2026-01-01T00:00:00.000Z',
      },
    ],
  },
};
