import type { LanguageModel } from '@calendar/ai';
import { type OpenModelCall, type OpenModelContext, openLanguageModel } from './openModel.ts';

/**
 * A model the Model Spike page can run phrases on: one loaded from a file
 * into the app, or the system's own. The store knows only this, so both
 * go through the same run, the same report and the same score.
 */
export interface SpikeEngine {
  readonly description: string;
  /** Whether it computes on the GPU; undefined where that is not the app's to know (Apple's model runs in iOS). */
  readonly gpu: boolean | undefined;
  /**
   * The model as the pipeline asks it. Each call's numbers go to `onCall`,
   * and once `cancelled` says so no further call starts.
   */
  readonly modelFor: (
    onCall: (call: OpenModelCall) => void,
    cancelled: () => boolean,
  ) => LanguageModel;
  readonly reasonNoGpu: string;
  /** Takes it out of the app's memory, where it is in it. */
  readonly release: () => Promise<void>;
  /** Ends the call under way, where the engine can. */
  readonly stop: () => Promise<void> | undefined;
}

/** A model loaded from a file through llama.rn. */
export const fileEngine = (context: OpenModelContext): SpikeEngine => ({
  description: context.model.desc,
  gpu: context.gpu,
  modelFor: (onCall, cancelled) => openLanguageModel(context, onCall, cancelled),
  reasonNoGpu: context.reasonNoGPU,
  release: () => context.release(),
  stop: () => context.stopCompletion(),
});

/** A call of a model that counts no tokens: its whole time, booked under the answer. */
const timedCall = (ms: number, error?: string): OpenModelCall => ({
  answerMs: ms,
  answerTokens: 0,
  ...(error === undefined ? {} : { error }),
  promptMs: 0,
  promptTokens: 0,
  readTokens: 0,
});

/**
 * Apple's own model, asked exactly as the app asks it today (its schema as
 * the pipeline hands it over, its questions side by side): what the open
 * models are held against on the same device. It lives in iOS, so there
 * is nothing of it to release or to stop, and it reports no tokens: a
 * call is its time alone.
 */
export const systemEngine = (model: LanguageModel, now: () => number): SpikeEngine => ({
  description: 'Apple Foundation Models',
  gpu: undefined,
  modelFor: (onCall, cancelled) => ({
    ...model,
    generateJson: async (request) => {
      const started = now();
      try {
        if (cancelled()) {
          throw new Error('The run was cut short.');
        }
        const answer = await model.generateJson(request);
        onCall(timedCall(now() - started));
        return answer;
      } catch (error) {
        onCall(timedCall(now() - started, error instanceof Error ? error.message : String(error)));
        throw error;
      }
    },
  }),
  reasonNoGpu: '',
  release: async () => undefined,
  stop: () => undefined,
});
