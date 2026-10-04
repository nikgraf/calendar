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
