import { type LanguageModel, strictSchema, withoutNulls } from '@calendar/ai';

/**
 * An open model run inside the app (llama.cpp through llama.rn) as the
 * app's LanguageModel. Not a model the app ships: it is here to measure
 * whether one could answer quick-add on an iPhone (Settings › Advanced ›
 * Model Spike, the development variant only). The request is the one the
 * model bench got its numbers with: the strict schema (every field
 * required, an optional one nullable, the nulls dropped on the way back),
 * thinking off, temperature 0.
 */

/**
 * The most an answer may run to. A draft is under 200 tokens; constrained
 * output has no length limit of its own, and a model that goes on writing
 * inside a text field would hold the phone for minutes.
 */
export const MAX_ANSWER_TOKENS = 512;

/** Room for the app's longest prompt and its answer. */
const CONTEXT_TOKENS = 4096;

/** What llama.rn reports about one completion. */
export interface RuntimeTimings {
  readonly cache_n?: number | undefined;
  readonly predicted_ms?: number | undefined;
  readonly predicted_n?: number | undefined;
  readonly prompt_ms?: number | undefined;
  readonly prompt_n?: number | undefined;
}

/** The part of a llama.rn context this file uses. */
export interface OpenModelContext {
  readonly completion: (params: Record<string, unknown>) => Promise<{
    readonly content?: string | undefined;
    readonly text?: string | undefined;
    readonly timings?: RuntimeTimings | undefined;
  }>;
  readonly gpu: boolean;
  readonly model: { readonly desc: string; readonly nParams: number; readonly size: number };
  readonly reasonNoGPU: string;
  readonly release: () => Promise<void>;
}

/** The part of llama.rn this file uses. */
export interface OpenModelRuntime {
  readonly initLlama: (
    params: Record<string, unknown>,
    onProgress?: (progress: number) => void,
  ) => Promise<OpenModelContext>;
}

/**
 * llama.rn, where this binary has it. The production variant is built
 * without the pod (`react-native.config.js`), and so is every binary from
 * before the dependency: there the native module is absent and installing
 * its bindings would fail on the first call, so the answer is "no
 * runtime". Loaded lazily inside a try, as every native package here is.
 */
export const loadOpenModelRuntime = (): OpenModelRuntime | undefined => {
  try {
    /* eslint-disable typescript/no-require-imports -- deliberate: see above */
    const { TurboModuleRegistry } = require('react-native') as typeof import('react-native');
    if (TurboModuleRegistry.get('RNLlama') === null) {
      return undefined;
    }
    return require('llama.rn') as OpenModelRuntime;
    /* eslint-enable typescript/no-require-imports */
  } catch {
    return undefined;
  }
};

/** One model call in numbers: how much of the prompt was read, how much was already cached, how fast. */
export interface OpenModelCall {
  readonly answerMs: number;
  readonly answerTokens: number;
  /** Prompt tokens the runtime did not have to read again: the prefix it kept from the call before. */
  readonly cachedTokens: number;
  /** Why the call gave no answer: the pipeline turns it into "couldn't be read", which says nothing. */
  readonly error?: string | undefined;
  readonly promptMs: number;
  /** Prompt tokens read in this call (the rest was cached). */
  readonly promptTokens: number;
}

export const callOf = (timings: RuntimeTimings | undefined): OpenModelCall => ({
  answerMs: timings?.predicted_ms ?? 0,
  answerTokens: timings?.predicted_n ?? 0,
  cachedTokens: timings?.cache_n ?? 0,
  promptMs: timings?.prompt_ms ?? 0,
  promptTokens: timings?.prompt_n ?? 0,
});

/** The model file loaded with every layer on the GPU where the device has one (the simulator has none). */
export const loadOpenModel = (
  runtime: OpenModelRuntime,
  { onProgress, path }: { readonly onProgress?: (percent: number) => void; readonly path: string },
): Promise<OpenModelContext> =>
  runtime.initLlama({ model: path, n_ctx: CONTEXT_TOKENS, n_gpu_layers: 99 }, onProgress);

/**
 * What the model wrote. The runtime's `content` is the answer alone, when
 * its chat parser gives one; `text` is everything, and on the simulator
 * began with the chat template's own opening of the assistant's turn
 * (`<|im_start|>assistant`) before the object. The grammar allows one
 * object and nothing else, so in `text` the answer starts at the first
 * brace.
 */
const answerText = (result: {
  readonly content?: string | undefined;
  readonly text?: string | undefined;
}): string => {
  const content = (result.content ?? '').trim();
  if (content) {
    return content;
  }
  const text = (result.text ?? '').trim();
  const start = text.indexOf('{');
  return start > 0 ? text.slice(start) : text;
};

/** How much of an answer that is no JSON the error keeps: enough to see what the model wrote instead. */
const SHOWN = 160;

/** The answer as JSON, or an error that shows how the answer began. */
const parseAnswer = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(
      `The answer is not JSON (${String(text.length)} characters): ${text.slice(0, SHOWN)}`,
    );
  }
};

/**
 * The loaded model as a LanguageModel. `onCall` gets each call's numbers,
 * or why it failed: a quick-add turn can ask the model more than once.
 * One context answers one call at a time, and the pipeline asks its
 * questions side by side (who is invited, beside the extraction), so the
 * calls wait for each other here.
 */
export const openLanguageModel = (
  context: OpenModelContext,
  onCall?: (call: OpenModelCall) => void,
): LanguageModel => {
  let last: Promise<unknown> = Promise.resolve();
  const generate = async (jsonSchema: unknown, prompt: string): Promise<unknown> => {
    let timings: RuntimeTimings | undefined;
    try {
      const result = await context.completion({
        enable_thinking: false,
        messages: [{ content: prompt, role: 'user' }],
        n_predict: MAX_ANSWER_TOKENS,
        response_format: {
          json_schema: { schema: strictSchema(jsonSchema), strict: true },
          type: 'json_schema',
        },
        temperature: 0,
      });
      ({ timings } = result);
      const text = answerText(result);
      if (!text) {
        throw new Error('The model returned an empty response.');
      }
      const answer = withoutNulls(parseAnswer(text));
      onCall?.(callOf(timings));
      return answer;
    } catch (error) {
      onCall?.({
        ...callOf(timings),
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  return {
    generateJson: ({ jsonSchema, prompt }) => {
      const next = last.then(
        () => generate(jsonSchema, prompt),
        () => generate(jsonSchema, prompt),
      );
      last = next.catch(() => undefined);
      return next;
    },
    status: async () => 'ready',
  };
};
