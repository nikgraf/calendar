import { runBackgroundRefresh } from './backend.ts';

/**
 * Keeps the local notification schedule fresh while the app is not
 * running: the OS holds at most 60 pending notifications, which a dense
 * calendar fills within days, and an event added elsewhere is only seen
 * after a pull. iOS runs this at its own discretion (a BGProcessingTask,
 * typically overnight or while idle), so the foreground refresh stays
 * the correctness path.
 *
 * Loaded with `require` in a try/catch like expo-notifications
 * (`notifications.ts`): a binary built before these modules existed —
 * the OTA preview path ships exactly such — simply has no background
 * refresh.
 */
const load = () => {
  try {
    return {
      // eslint-disable-next-line typescript/no-require-imports -- deliberate: see above
      background: require('expo-background-task') as typeof import('expo-background-task'),
      // eslint-disable-next-line typescript/no-require-imports -- deliberate: see above
      taskManager: require('expo-task-manager') as typeof import('expo-task-manager'),
    };
  } catch {
    return undefined;
  }
};

const TASK = 'solunivo.backgroundRefresh';
/** Minutes; iOS treats it as a lower bound and picks its own windows. */
const MINIMUM_INTERVAL = 30;

const modules = load();

// Defined while the bundle evaluates: a background launch runs the task
// before any component mounts.
modules?.taskManager.defineTask(TASK, () =>
  runBackgroundRefresh().then(
    () => modules.background.BackgroundTaskResult.Success,
    () => modules.background.BackgroundTaskResult.Failed,
  ),
);

/** Registers the periodic task once the app runs; idempotent. */
export const registerBackgroundRefresh = (): void => {
  if (!modules) {
    return;
  }
  const { background } = modules;
  background
    .getStatusAsync()
    .then((status) =>
      status === background.BackgroundTaskStatus.Available
        ? background.registerTaskAsync(TASK, { minimumInterval: MINIMUM_INTERVAL })
        : undefined,
    )
    .catch(() => {
      // Without background refresh the foreground refresh still covers it.
    });
};

/** Development only: runs the registered task now (debug builds). */
export const triggerBackgroundRefreshForTesting = (): Promise<boolean> =>
  modules ? modules.background.triggerTaskWorkerForTestingAsync() : Promise.resolve(false);
