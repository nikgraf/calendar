// "Another device" adds a one-hour event in the run calendar, starting at
// the next whole hour plus HOURS_AHEAD hours (a string; default 1), so it
// sits near what the day view shows. Params: TITLE, HOURS_AHEAD.
const HOUR = 3_600_000;
const ahead = Number(typeof HOURS_AHEAD === 'undefined' ? '1' : HOURS_AHEAD);
const start = Math.ceil(Date.now() / HOUR) * HOUR + ahead * HOUR;
const url =
  'https://www.googleapis.com/calendar/v3/calendars/' +
  encodeURIComponent(MAESTRO_LIVE_CALENDAR_ID) +
  '/events?sendUpdates=none';
const response = http.post(url, {
  body: JSON.stringify({
    end: { dateTime: new Date(start + HOUR).toISOString() },
    start: { dateTime: new Date(start).toISOString() },
    summary: TITLE,
  }),
  headers: {
    Authorization: 'Bearer ' + MAESTRO_LIVE_ACCESS_TOKEN,
    'Content-Type': 'application/json',
  },
});
if (!response.ok) {
  throw new Error('events.insert ' + response.status + ': ' + response.body);
}
output.inserted = json(response.body).id;
