// This run's event by exact title in the run calendar → output.found,
// output.event ({ id, etag, status, summary, start, end } or null).
// Params: TITLE. Globals from the sidecar: MAESTRO_LIVE_ACCESS_TOKEN,
// MAESTRO_LIVE_CALENDAR_ID (setup prints them; the CLI injects MAESTRO_*).
const url =
  'https://www.googleapis.com/calendar/v3/calendars/' +
  encodeURIComponent(MAESTRO_LIVE_CALENDAR_ID) +
  '/events?showDeleted=true&maxResults=50&q=' +
  encodeURIComponent(TITLE);
const response = http.get(url, {
  headers: { Authorization: 'Bearer ' + MAESTRO_LIVE_ACCESS_TOKEN },
});
if (!response.ok) {
  throw new Error('events.list ' + response.status + ': ' + response.body);
}
const items = json(response.body).items || [];
const match = items.find((item) => item.summary === TITLE && item.status !== 'cancelled');
output.found = !!match;
output.event = match
  ? {
      end: match.end,
      etag: match.etag,
      id: match.id,
      start: match.start,
      status: match.status,
      summary: match.summary,
    }
  : null;
