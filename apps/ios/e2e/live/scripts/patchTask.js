// "Another device" completes or reopens the task. Params: TASK_ID, STATUS
// ('completed' | 'needsAction'); reopening also clears `completed`, as
// the API requires.
const url =
  'https://tasks.googleapis.com/tasks/v1/lists/' +
  encodeURIComponent(MAESTRO_LIVE_LIST_ID) +
  '/tasks/' +
  encodeURIComponent(TASK_ID);
const body = STATUS === 'needsAction' ? { completed: null, status: STATUS } : { status: STATUS };
const response = http.request(url, {
  body: JSON.stringify(body),
  headers: {
    Authorization: 'Bearer ' + MAESTRO_LIVE_ACCESS_TOKEN,
    'Content-Type': 'application/json',
  },
  method: 'PATCH',
});
if (!response.ok) {
  throw new Error('tasks.patch ' + response.status + ': ' + response.body);
}
output.patchedStatus = json(response.body).status;
