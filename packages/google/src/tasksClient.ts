import { Context, Effect, Layer } from 'effect';
import { HttpClient, HttpClientRequest } from 'effect/unstable/http';
import { GcalTask, GcalTaskListsPage, GcalTasksPage } from './apiTypes.ts';
import { TokenManager } from './oauth/tokenManager.ts';
import { definedParams, makeRequestCore, type GoogleRequestError } from './requestCore.ts';

/** Separate host from the Calendar API — Tasks is its own service. */
const BASE_URL = 'https://tasks.googleapis.com/tasks/v1';

export type TaskWireStatus = 'completed' | 'needsAction';

export interface ListTasksParams {
  readonly pageToken?: string | undefined;
  /** RFC 3339 watermark; omitted on a full pass. */
  readonly updatedMin?: string | undefined;
}

export interface GoogleTasksClientShape {
  readonly listTaskLists: (params: {
    readonly accountId: string;
    readonly pageToken?: string | undefined;
  }) => Effect.Effect<GcalTaskListsPage, GoogleRequestError>;
  readonly listTasks: (params: {
    readonly accountId: string;
    readonly params: ListTasksParams;
    readonly taskListId: string;
  }) => Effect.Effect<GcalTasksPage, GoogleRequestError>;
  readonly patchTask: (params: {
    readonly accountId: string;
    readonly status: TaskWireStatus;
    readonly taskId: string;
    readonly taskListId: string;
  }) => Effect.Effect<GcalTask, GoogleRequestError>;
}

const make: Effect.Effect<GoogleTasksClientShape, never, HttpClient.HttpClient | TokenManager> =
  Effect.gen(function* () {
    const { requestJson } = yield* makeRequestCore;

    const tasksUrl = (taskListId: string, suffix = ''): string =>
      `${BASE_URL}/lists/${encodeURIComponent(taskListId)}/tasks${suffix}`;

    return {
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
                maxResults: 100,
                pageToken: params.pageToken,
                // Always on: completed tasks render struck-through, hidden
                // covers tasks completed before this pass, and deleted
                // tombstones drive local removal on incremental polls.
                showCompleted: 'true',
                showDeleted: 'true',
                showHidden: 'true',
                updatedMin: params.updatedMin,
              }),
            ),
          ),
          GcalTasksPage,
          // The shared error context slots carry list/task ids for tasks.
          { calendarId: taskListId },
        ),

      patchTask: ({ accountId, status, taskId, taskListId }) =>
        requestJson(
          accountId,
          HttpClientRequest.patch(tasksUrl(taskListId, `/${encodeURIComponent(taskId)}`)).pipe(
            // Un-completing must clear the completion timestamp explicitly;
            // JSON null is Google's clear-this-field convention.
            HttpClientRequest.bodyJsonUnsafe(
              status === 'completed' ? { status } : { completed: null, status },
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
