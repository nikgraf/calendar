// "Another device" renames the event: a PATCH without If-Match, no guest
// mail. The app's next edit then carries a stale etag. Params: EVENT_ID,
// SUMMARY.
const url =
  'https://www.googleapis.com/calendar/v3/calendars/' +
  encodeURIComponent(MAESTRO_LIVE_CALENDAR_ID) +
  '/events/' +
  encodeURIComponent(EVENT_ID) +
  '?sendUpdates=none';
const response = http.request(url, {
  body: JSON.stringify({ summary: SUMMARY }),
  headers: {
    Authorization: 'Bearer ' + MAESTRO_LIVE_ACCESS_TOKEN,
    'Content-Type': 'application/json',
  },
  method: 'PATCH',
});
if (!response.ok) {
  throw new Error('events.patch ' + response.status + ': ' + response.body);
}
output.patched = json(response.body).etag;
