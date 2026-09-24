// "Another device" adds an event to the run calendar. ALL_DAY: 'true'
// makes it an all-day event today (the device's local date) — it shows in
// the all-day lane at the top of the day view whatever the time of day;
// otherwise a one-hour event starting at the next whole hour plus
// HOURS_AHEAD (default 1). Params: TITLE, ALL_DAY, HOURS_AHEAD.
const HOUR = 3_600_000;
const allDay = typeof ALL_DAY !== 'undefined' && ALL_DAY === 'true';
const ahead = Number(typeof HOURS_AHEAD === 'undefined' ? '1' : HOURS_AHEAD);
const pad = (n) => String(n).padStart(2, '0');
const day = (date) =>
  date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate());
const start = Math.ceil(Date.now() / HOUR) * HOUR + ahead * HOUR;
const today = new Date();
const tomorrow = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
const times = allDay
  ? { end: { date: day(tomorrow) }, start: { date: day(today) } }
  : {
      end: { dateTime: new Date(start + HOUR).toISOString() },
      start: { dateTime: new Date(start).toISOString() },
    };
const url =
  'https://www.googleapis.com/calendar/v3/calendars/' +
  encodeURIComponent(MAESTRO_LIVE_CALENDAR_ID) +
  '/events?sendUpdates=none';
const response = http.post(url, {
  body: JSON.stringify(Object.assign({ summary: TITLE }, times)),
  headers: {
    Authorization: 'Bearer ' + MAESTRO_LIVE_ACCESS_TOKEN,
    'Content-Type': 'application/json',
  },
});
if (!response.ok) {
  throw new Error('events.insert ' + response.status + ': ' + response.body);
}
output.inserted = json(response.body).id;
