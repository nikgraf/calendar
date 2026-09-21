import type { GoogleFixture } from '@calendar/sync/testing/googleFixture';

/** Today as the RFC 3339 midnight-UTC `due` the Tasks API uses. */
const todayDue = (): string => {
  const date = new Date();
  const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  return `${iso}T00:00:00.000Z`;
};

/**
 * The signed-in Google account the Maestro flows see when Metro runs
 * with EXPO_PUBLIC_CALENDAR_GOOGLE=fixture (CI does): one writable
 * calendar for the create-event flow, one task list for the task lane
 * and task-convert flows. Served by the in-process fake API; nothing
 * here ever reaches Google.
 */
export const googleFixture: GoogleFixture = {
  accounts: [{ email: 'fixture@solunivo.test', id: 'fixture-google', tasksEnabled: true }],
  calendars: [
    {
      accessRole: 'owner',
      backgroundColor: '#4285f4',
      id: 'mock-calendar',
      primary: true,
      summary: 'Mock Calendar',
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
