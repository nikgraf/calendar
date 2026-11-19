import {
  APPLE_REASON_STATUS,
  type LanguageModel,
  type ModelAvailability,
  type ModelStatus,
} from '@calendar/ai';
import { loadModelAvailabilityModule } from '../modules/solunivo-model-availability/index.ts';

/** Give up rather than leaving the UI stuck behind a stalled generation. */
const GENERATE_TIMEOUT_MS = 60_000;
/**
 * The availability check normally answers promptly; past this
 * the check counts as failed rather than leaving "Checking…" up for good.
 */
export const AVAILABILITY_TIMEOUT_MS = 5000;

type AppleModel = Pick<
  (typeof import('@react-native-ai/apple'))['AppleFoundationModels'],
  'generateText' | 'getModelInfo'
>;

/**
 * The package resolves its turbo module with `getEnforcing`, which throws
 * while the module is being *evaluated* — so a static import would crash
 * the whole app at launch on any binary built without the pod (a dev
 * client from before this dependency, most often). Loading it lazily
 * inside a try turns that into "no model available", which is what the
 * rest of the app already handles.
 */
const loadModule = (): AppleModel | undefined => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
    const module = require('@react-native-ai/apple') as typeof import('@react-native-ai/apple');
    return module.AppleFoundationModels;
  } catch {
    return undefined;
  }
};

const withTimeout = async <T>(work: Promise<T>, ms: number, message: string): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * The availability module's answer in the shared shape: Foundation Models'
 * reason mapped onto a status and kept verbatim for display. A reason a
 * newer iOS adds stays 'unavailable' with its name; a reply of any other
 * shape is a check that failed, not a model that is unavailable.
 */
export const availabilityOfReply = (reply: unknown): ModelAvailability => {
  const { reason, status } = (reply ?? {}) as { reason?: unknown; status?: unknown };
  if (status === 'available') {
    return { status: 'ready' };
  }
  if (status !== 'unavailable') {
    return {
      checkError: `Unexpected reply from the availability check: ${JSON.stringify(reply)}`,
      status: 'unavailable',
    };
  }
  const nativeReason = typeof reason === 'string' && reason !== '' ? reason : undefined;
  return {
    nativeReason,
    status:
      (nativeReason === undefined ? undefined : APPLE_REASON_STATUS.get(nativeReason)) ??
      'unavailable',
  };
};

/** What the check reads; a binary can lack either. */
export interface AvailabilitySources {
  /** The package's model info: there whenever generation is. */
  readonly ai:
    | { readonly getModelInfo: (locale?: string, model?: string) => Promise<unknown> }
    | undefined;
  /** The local availability module: there from the build that added it. */
  readonly bridge: { readonly check: () => Promise<unknown> } | undefined;
}

/**
 * Whether the model can run and why not, for `status` and `availability`
 * alike. Generation needs the package, so without it nothing else matters.
 * The local availability module supplies the reason when it loads;
 * otherwise the package's model info supplies it. A stale dev client
 * without either current API reports a failed check.
 */
export const checkAvailability = async ({
  ai,
  bridge,
}: AvailabilitySources): Promise<ModelAvailability> => {
  if (!ai) {
    return { status: 'missing-module' };
  }
  if (!bridge) {
    try {
      const info = await withTimeout(
        // Native promise callbacks follow these two argument slots, even
        // when neither optional string is provided.
        ai.getModelInfo(undefined, undefined),
        AVAILABILITY_TIMEOUT_MS,
        `iOS did not answer within ${String(AVAILABILITY_TIMEOUT_MS / 1000)} s.`,
      );
      const { availability } = (info ?? {}) as { availability?: unknown };
      if (typeof availability !== 'string' || availability === '') {
        throw new Error(`Unexpected reply from the model info check: ${JSON.stringify(info)}`);
      }
      return availabilityOfReply(
        availability === 'available'
          ? { status: 'available' }
          : { reason: availability, status: 'unavailable' },
      );
    } catch (error) {
      // The package is here but refuses to answer: a check that failed,
      // not a build without the framework.
      return { checkError: messageOf(error), reasonsUnavailable: true, status: 'unavailable' };
    }
  }
  try {
    return availabilityOfReply(
      await withTimeout(
        bridge.check(),
        AVAILABILITY_TIMEOUT_MS,
        `iOS did not answer within ${String(AVAILABILITY_TIMEOUT_MS / 1000)} s.`,
      ),
    );
  } catch (error) {
    return { checkError: messageOf(error), status: 'unavailable' };
  }
};

/**
 * Apple's on-device Foundation Models as the app's LanguageModel. Nothing
 * leaves the device and there is no per-request cost; the framework needs
 * Apple Intelligence hardware, so `status` gates every entry point rather
 * than letting calls fail.
 */
export const createAppleLanguageModel = (load: () => AppleModel | undefined): LanguageModel => {
  const deviceAvailability = (): Promise<ModelAvailability> =>
    checkAvailability({ ai: load(), bridge: loadModelAvailabilityModule() });

  return {
    availability: deviceAvailability,
    generateJson: async ({ jsonSchema, prompt }) => {
      const ai = load();
      if (!ai) {
        throw new Error('Apple foundation models are not built into this app.');
      }
      const { content } = await withTimeout(
        ai.generateText(
          [{ content: prompt, role: 'user' }],
          // Guided generation: the framework constrains decoding to the
          // schema, so the reply parses — though it can still be
          // semantically wrong, which is why the caller re-validates.
          { schema: jsonSchema as Record<string, unknown>, temperature: 0 },
        ),
        GENERATE_TIMEOUT_MS,
        'Generation timed out.',
      );
      const text = content
        .filter((part): part is { text: string; type: 'text' } => part.type === 'text')
        .map((part) => part.text)
        .join('')
        .trim();
      if (!text) {
        // Distinct from a parse failure: the model answered with nothing,
        // which is a provider problem rather than an unclear phrase.
        throw new Error('The model returned an empty response.');
      }
      return JSON.parse(text) as unknown;
    },
    status: async (): Promise<ModelStatus> => (await deviceAvailability()).status,
  };
};

export const appleLanguageModel: LanguageModel = createAppleLanguageModel(loadModule);
