// events.get → output.event ({ status, summary, start, end }); a 404/410
// becomes { status: 'http 404' } so a flow can pin how Google answers for
// a deleted event. Params: EVENT_ID.
const url =
  'https://www.googleapis.com/calendar/v3/calendars/' +
  encodeURIComponent(MAESTRO_LIVE_CALENDAR_ID) +
  '/events/' +
  encodeURIComponent(EVENT_ID);
const response = http.get(url, {
  headers: { Authorization: 'Bearer ' + MAESTRO_LIVE_ACCESS_TOKEN },
});
if (response.status === 404 || response.status === 410) {
  output.event = { status: 'http ' + response.status };
} else if (!response.ok) {
  throw new Error('events.get ' + response.status + ': ' + response.body);
} else {
  const event = json(response.body);
  output.event = {
    end: event.end,
    etag: event.etag,
    start: event.start,
    status: event.status,
    summary: event.summary,
  };
}
