import {
  type AssistantModelState,
  type LanguageModel,
  type ModelStatus,
  statusOf,
} from '@calendar/ai';
import { useSyncExternalStore } from 'react';

/**
 * The Assistant's own model as this window sees it (electron/assistantModel/):
 * where it stands, followed over `onAssistantModel`, and the
 * `LanguageModel` the Assistant's tuned reader asks. Apple's model and a
 * served one stay `desktopLanguageModel` (find a time, search, capture).
 */

let state: AssistantModelState | undefined;
const listeners = new Set<() => void>();
let following = false;

const follow = () => {
  if (following) {
    return;
  }
  following = true;
  window.calendarBridge.onAssistantModel((next) => {
    state = next;
    for (const listener of listeners) {
      listener();
    }
  });
};

const subscribe = (listener: () => void) => {
  follow();
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/** Where the Assistant's model stands; undefined until main has answered. */
export const useAssistantModelState = (): AssistantModelState | undefined =>
  useSyncExternalStore(subscribe, () => state);

/** The status the Assistant shows: the test model counts as ready; null until known. */
export const assistantStatusOf = (current: AssistantModelState | undefined): ModelStatus | null =>
  current === undefined
    ? null
    : current.kind === 'unsupported' && current.reason === 'fixture'
      ? 'ready'
      : statusOf(current);

/** Fits the Assistant's field while its model is not on this Mac. */
export const assistantFieldCopy = (current: AssistantModelState | undefined): string => {
  switch (current?.kind) {
    case 'downloading':
    case 'verifying':
      return 'The Assistant will be available soon';
    case 'failed':
      return 'The model’s download did not finish';
    case 'unsupported':
      return 'The Assistant is not available';
    default:
      return 'The Assistant needs its model';
  }
};

export const desktopAssistantModel: LanguageModel = {
  generateJson: async ({ prompt }) => {
    const result = await window.calendarBridge.assistantGenerate(prompt);
    return JSON.parse(result.json) as unknown;
  },
  info: async () => ({ contextTokens: 4096, name: 'Solunivo Assistant' }),
  status: async () => {
    follow();
    const current = state ?? (await window.calendarBridge.assistantState());
    return assistantStatusOf(current) ?? 'not-ready';
  },
};

let asked = false;

const askNow = () => void window.calendarBridge.assistantAsk().catch(() => undefined);

/**
 * The question at launch, once the first-run setup is out of the way and
 * the window is in front: main asks only while the model was never
 * answered for its version, and once a launch.
 */
export const askForAssistantModel = (): void => {
  if (asked) {
    return;
  }
  asked = true;
  if (document.hasFocus()) {
    askNow();
    return;
  }
  window.addEventListener('focus', askNow, { once: true });
};
