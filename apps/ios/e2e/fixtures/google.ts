import type { GoogleFixture } from '@calendar/sync/testing/googleFixture';

/** Today as the RFC 3339 midnight-UTC `due` the Tasks API uses. */
const todayDue = (): string => {
  const date = new Date();
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

/** The UTC calendar day `days` from today, YYYY-MM-DD. */
const utcDay = (days: number): string =>
  new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

/**
 * The signed-in Google account the Maestro flows see when Metro runs
 * with EXPO_PUBLIC_CALENDAR_GOOGLE=fixture (CI does): one writable
 * calendar for the create-event flow, one task list for the task lane
 * and task-convert flows, one contact birthday for the birthday flow.
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
  // One event the mirror flow copies, weeks out so no day-view flow meets it.
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
    ],
    // The zone-series flow's event: weekly on today's weekday in
    // Asia/Kolkata, which Hermes rejects (it takes Asia/Calcutta), with an
    // EXDATE in that zone too. 19:30 there is 14:00 UTC, so the Kolkata
    // and UTC days agree. Weekly, not daily: the day pager lays out the
    // neighbouring days off-screen, and a copy there is the element
    // Maestro picks first. In the mirror flow's destination, so nothing
    // mirrors it.
    'mock-shared': [
      {
        end: { dateTime: `${utcDay(-21)}T20:00:00+05:30`, timeZone: 'Asia/Kolkata' },
        id: 'fixture-kolkata',
        recurrence: [
          'RRULE:FREQ=WEEKLY',
          `EXDATE;TZID=Asia/Kolkata:${utcDay(-14).replaceAll('-', '')}T193000`,
        ],
        start: { dateTime: `${utcDay(-21)}T19:30:00+05:30`, timeZone: 'Asia/Kolkata' },
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
  ],
  taskLists: [{ id: 'mock-list', title: 'Mock Tasks' }],
  tasks: {
    'mock-list': [
      {
        due: todayDue(),
        id: 'task-fixture',
        status: 'needsAction',
        title: 'Fixture task',
        updated: '2026-01-01T00:00:00.000Z',
      },
    ],
  },
};
