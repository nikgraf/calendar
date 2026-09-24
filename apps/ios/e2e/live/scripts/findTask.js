// This run's task by exact title in the run list → output.found,
// output.task ({ id, status } or null). Deleted tasks never match.
// Params: TITLE. Globals: MAESTRO_LIVE_ACCESS_TOKEN, MAESTRO_LIVE_LIST_ID.
const url =
  'https://tasks.googleapis.com/tasks/v1/lists/' +
  encodeURIComponent(MAESTRO_LIVE_LIST_ID) +
  '/tasks?showCompleted=true&showHidden=true&showDeleted=true&maxResults=100';
const response = http.get(url, {
  headers: { Authorization: 'Bearer ' + MAESTRO_LIVE_ACCESS_TOKEN },
});
if (!response.ok) {
  throw new Error('tasks.list ' + response.status + ': ' + response.body);
}
const items = json(response.body).items || [];
const match = items.find((item) => item.title === TITLE && !item.deleted);
output.found = !!match;
output.task = match ? { id: match.id, status: match.status } : null;
