import type { LanguageModel } from '@calendar/ai';
import { type OpenModelCall, type OpenModelContext, openLanguageModel } from './openModel.ts';

/**
 * A model the Model Spike page can run phrases on: one loaded from a file
 * into the app. The store knows only this, so every model goes through
 * the same run, the same report and the same score.
 */
export interface SpikeEngine {
  readonly description: string;
  /** Whether it computes on the GPU. */
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
