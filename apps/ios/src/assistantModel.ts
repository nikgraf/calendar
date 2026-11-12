import type { LanguageModel, ModelStatus } from '@calendar/ai';
import { type AssistantModelState, statusOf } from './assistantDownload.ts';
import { letGoLlama, takeLlama } from './llamaOwner.ts';
import {
  loadOpenModel,
  type OpenModelContext,
  type OpenModelRuntime,
  openLanguageModel,
} from './openModel.ts';

/**
 * The Assistant's model as the app's LanguageModel: the downloaded file
 * (`assistantDownload.ts`), loaded with llama.rn on the first question and
 * let go when the app leaves the screen or iOS warns of memory. iOS
 * refuses GPU work in the background, and a suspended app that holds a
 * gigabyte and a half is the first one iOS ends: the next question loads
 * it again (about a second and a half on an iPhone 16).
 *
 * Leaving while it loads lets the context go once it is there; leaving
 * while it answers stops the answer and refuses the questions queued
 * behind it, as the Model Spike page does (`modelSpikeStore.ts`). A
 * question that takes longer than `ANSWER_LIMIT_MS` is stopped.
 */

export const ANSWER_LIMIT_MS = 30_000;

export interface AssistantModelDeps {
  /** Whether the app is in front: iOS refuses GPU work behind it (`AppState.currentState === 'active'`). */
  readonly foreground?: (() => boolean) | undefined;
  readonly runtime: OpenModelRuntime | undefined;
  readonly state: () => AssistantModelState;
}

export interface AssistantModel extends LanguageModel {
  /** The app left the screen: an answer under way is stopped and the context let go. */
  readonly leave: () => Promise<void>;
  /** iOS needs the memory: the context goes once no question is being answered. */
  readonly relieve: () => Promise<void>;
}

export const createAssistantModel = ({
  foreground = () => true,
  runtime,
  state,
}: AssistantModelDeps): AssistantModel => {
  let context: OpenModelContext | undefined;
  /** The context's questions, one at a time (`openLanguageModel` queues them). */
  let asking: LanguageModel | undefined;
  let loading: Promise<OpenModelContext> | undefined;
  /** Raised while the app is away: nothing queued may reach the runtime. */
  let away = false;
  let busy = 0;
  /** Counts the times the context was let go, so a load that lands after one is not kept. */
  let generation = 0;
  let queue: Promise<unknown> = Promise.resolve();

  const letGo = async (): Promise<boolean> => {
    away = true;
    generation += 1;
    // Everything is taken before the first await: a question waiting behind
    // the stopped one must find nothing to reuse and nothing loading.
    const held = context;
    const pending = loading;
    context = undefined;
    asking = undefined;
    loading = undefined;
    letGoLlama('assistant');
    if (held !== undefined) {
      try {
        await held.stopCompletion();
      } catch {
        // A context the runtime no longer knows has nothing to stop.
      }
      await held.release().catch(() => undefined);
    }
    // A load under way lets its context go once it lands.
    if (pending !== undefined) {
      const late = await pending.catch(() => undefined);
      await late?.release().catch(() => undefined);
    }
    return true;
  };

  /** Throws where the context was let go after the question was asked (`asked`). */
  const stillAsked = (asked: number) => {
    // A question that arrives behind the screen (a dictation that ended there) is not answered either.
    if (asked !== generation || !foreground()) {
      throw new Error('The app left the screen.');
    }
  };

  const contextFor = async (
    path: string,
    asked: number,
  ): Promise<{ readonly answer: LanguageModel; readonly loaded: OpenModelContext }> => {
    if (context !== undefined && asking !== undefined) {
      return { answer: asking, loaded: context };
    }
    if (runtime === undefined) {
      throw new Error('This build has no model runtime.');
    }
    if (!(await takeLlama('assistant', letGo))) {
      throw new Error('The Model Spike page is measuring with the model runtime.');
    }
    stillAsked(asked);
    away = false;
    if (loading === undefined) {
      const attempt = loadOpenModel(runtime, { path });
      loading = attempt;
      // A load that fails is tried again by the next question, not awaited again.
      attempt.catch(() => {
        if (loading === attempt) {
          loading = undefined;
          letGoLlama('assistant');
        }
      });
    }
    const loaded = await loading;
    // Let go while it loaded: `letGo` releases what the load brings.
    stillAsked(asked);
    if (context === undefined || asking === undefined) {
      loading = undefined;
      context = loaded;
      asking = openLanguageModel(loaded, undefined, () => away);
    }
    return { answer: asking, loaded: context };
  };

  return {
    generateJson: (request) => {
      // One question at a time, each timed from when it reaches the model:
      // a turn about several drafts asks once a draft. A question asked
      // before the app left the screen is not answered after it.
      const asked = generation;
      busy += 1;
      const ask = async (): Promise<unknown> => {
        stillAsked(asked);
        const now = state();
        if (now.kind !== 'ready') {
          throw new Error('The Assistant’s model is not ready.');
        }
        const { answer, loaded } = await contextFor(now.path, asked);
        const timer = setTimeout(() => {
          void Promise.resolve()
            .then(() => loaded.stopCompletion())
            .catch(() => undefined);
        }, ANSWER_LIMIT_MS);
        try {
          return await answer.generateJson(request);
        } finally {
          clearTimeout(timer);
        }
      };
      const next = queue.then(ask, ask).finally(() => {
        busy -= 1;
      });
      queue = next.catch(() => undefined);
      return next;
    },
    info: async () => ({ name: 'Solunivo quick add' }),
    leave: async () => {
      await letGo();
    },
    relieve: async () => {
      // A question asked or waiting keeps the context: it is loaded for it.
      if (busy === 0) {
        await letGo();
      }
    },
    status: async (): Promise<ModelStatus> => statusOf(state()),
  };
};
