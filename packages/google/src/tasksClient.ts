import { Context, Effect, Layer } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/http';
import { GcalTask, GcalTaskListsPage, GcalTasksPage } from './apiTypes.ts';
import { TokenManager } from './oauth/tokenManager.ts';
import { definedParams, makeRequestCore, type GoogleRequestError } from './requestCore.ts';

/** Separate host from the Calendar API — Tasks is its own service. */
const BASE_URL = 'https://tasks.googleapis.com/tasks/v1';

export type TaskWireStatus = 'completed' | 'needsAction';

/** Fields we write on insert/patch. `due: null` clears the date (patch). */
export interface TaskWriteChanges {
  readonly due?: string | null | undefined;
  readonly notes?: string | undefined;
  readonly status?: TaskWireStatus | undefined;
  readonly title?: string | undefined;
}

export interface ListTasksParams {
  /**
   * Each task's id, parent and position only (a partial response),
   * deleted ones left out: the list's order, read when its `updated`
   * says an insert, delete or move renumbered it.
   */
  readonly orderOnly?: boolean | undefined;
  readonly pageToken?: string | undefined;
  /** RFC 3339 watermark; omitted on a full pass. */
  readonly updatedMin?: string | undefined;
}

export interface GoogleTasksClientShape {
  readonly deleteTask: (params: {
    readonly accountId: string;
    readonly taskId: string;
    readonly taskListId: string;
  }) => Effect.Effect<void, GoogleRequestError>;
  readonly insertTask: (params: {
    readonly accountId: string;
    /** Creates it as a subtask of this task (first among its siblings). */
    readonly parent?: string | undefined;
    readonly task: { readonly due?: string; readonly notes?: string; readonly title: string };
    readonly taskListId: string;
  }) => Effect.Effect<GcalTask, GoogleRequestError>;
  readonly listTaskLists: (params: {
    readonly accountId: string;
    readonly pageToken?: string | undefined;
  }) => Effect.Effect<GcalTaskListsPage, GoogleRequestError>;
  readonly listTasks: (params: {
    readonly accountId: string;
    readonly params: ListTasksParams;
    readonly taskListId: string;
  }) => Effect.Effect<GcalTasksPage, GoogleRequestError>;
  /**
   * `tasks.move`. To another list of the same account: the task keeps its
   * id and its subtasks come along, still nested under it; a subtask
   * moved on its own lands as a task of its own. Inside its list: under
   * `parent` (omitted: a task of its own) right after `previous`
   * (omitted: first among those siblings), which must be one of them
   * (else 400). Google renumbers the siblings' positions and bumps no
   * `updated`, and takes any depth: one level is the caller's rule
   * (verified live).
   */
  readonly moveTask: (params: {
    readonly accountId: string;
    readonly destinationTaskListId?: string | undefined;
    readonly parent?: string | undefined;
    readonly previous?: string | undefined;
    readonly taskId: string;
    readonly taskListId: string;
  }) => Effect.Effect<GcalTask, GoogleRequestError>;
  readonly patchTask: (params: {
    readonly accountId: string;
    readonly changes: TaskWriteChanges;
    readonly taskId: string;
    readonly taskListId: string;
  }) => Effect.Effect<GcalTask, GoogleRequestError>;
}

const tasksUrl = (taskListId: string, suffix = ''): string =>
  `${BASE_URL}/lists/${encodeURIComponent(taskListId)}/tasks${suffix}`;

const make: Effect.Effect<GoogleTasksClientShape, never, HttpClient.HttpClient | TokenManager> =
  Effect.gen(function* () {
    const { executeAuthed, failForStatus, requestJson } = yield* makeRequestCore;

    return {
      deleteTask: ({ accountId, taskId, taskListId }) =>
        Effect.gen(function* () {
          const response = yield* executeAuthed(
            accountId,
            HttpClientRequest.delete(tasksUrl(taskListId, `/${encodeURIComponent(taskId)}`)),
          );
          if (response.status >= 400) {
            return yield* failForStatus(response, { calendarId: taskListId, eventId: taskId });
          }
        }),

      insertTask: ({ accountId, parent, task, taskListId }) =>
        requestJson(
          accountId,
          HttpClientRequest.post(tasksUrl(taskListId)).pipe(
            HttpClientRequest.setUrlParams(definedParams({ parent })),
            HttpClientRequest.bodyJsonUnsafe(task),
          ),
          GcalTask,
          { calendarId: taskListId },
        ),

      listTaskLists: ({ accountId, pageToken }) =>
        requestJson(
          accountId,
          HttpClientRequest.get(`${BASE_URL}/users/@me/lists`).pipe(
            HttpClientRequest.setUrlParams(definedParams({ maxResults: 100, pageToken })),
          ),
          GcalTaskListsPage,
        ),

      listTasks: ({ accountId, params, taskListId }) =>
        requestJson(
          accountId,
          HttpClientRequest.get(tasksUrl(taskListId)).pipe(
            HttpClientRequest.setUrlParams(
              definedParams({
                fields: params.orderOnly ? 'nextPageToken,items(id,parent,position)' : undefined,
                maxResults: 100,
                pageToken: params.pageToken,
                // Always on: completed tasks render struck-through, hidden
                // covers tasks completed before this pass, and deleted
                // tombstones drive local removal on incremental polls.
                showCompleted: 'true',
                showDeleted: params.orderOnly ? undefined : 'true',
                showHidden: 'true',
                updatedMin: params.updatedMin,
              }),
            ),
          ),
          GcalTasksPage,
          // The shared error context slots carry list/task ids for tasks.
          { calendarId: taskListId },
        ),

      moveTask: ({ accountId, destinationTaskListId, parent, previous, taskId, taskListId }) =>
        requestJson(
          accountId,
          HttpClientRequest.post(tasksUrl(taskListId, `/${encodeURIComponent(taskId)}/move`)).pipe(
            HttpClientRequest.setUrlParams(
              definedParams({ destinationTasklist: destinationTaskListId, parent, previous }),
            ),
          ),
          GcalTask,
          { calendarId: taskListId, eventId: taskId },
        ),

      patchTask: ({ accountId, changes, taskId, taskListId }) =>
        requestJson(
          accountId,
          HttpClientRequest.patch(tasksUrl(taskListId, `/${encodeURIComponent(taskId)}`)).pipe(
            // Un-completing must clear the completion timestamp explicitly;
            // JSON null is Google's clear-this-field convention (same for
            // clearing due).
            HttpClientRequest.bodyJsonUnsafe(
              changes.status === 'needsAction' ? { ...changes, completed: null } : changes,
            ),
          ),
          GcalTask,
          { calendarId: taskListId, eventId: taskId },
        ),
    };
  });

export class GoogleTasksClient extends Context.Service<GoogleTasksClient, GoogleTasksClientShape>()(
  'google/TasksClient',
) {
  static readonly layer: Layer.Layer<
    GoogleTasksClient,
    never,
    HttpClient.HttpClient | TokenManager
  > = Layer.effect(GoogleTasksClient)(make);
}
