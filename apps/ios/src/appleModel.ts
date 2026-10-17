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
 * The availability check is a property read, normally instant; past this
 * the check counts as failed rather than leaving "Checking…" up for good.
 */
export const AVAILABILITY_TIMEOUT_MS = 5000;

/**
 * The package resolves its turbo module with `getEnforcing`, which throws
 * while the module is being *evaluated* — so a static import would crash
 * the whole app at launch on any binary built without the pod (a dev
 * client from before this dependency, most often). Loading it lazily
 * inside a try turns that into "no model available", which is what the
 * rest of the app already handles.
 */
const loadModule = (): typeof import('@react-native-ai/apple') | undefined => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- see above
    return require('@react-native-ai/apple') as typeof import('@react-native-ai/apple');
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
  /** The package's yes/no (`AppleFoundationModels`): there whenever generation is. */
  readonly ai: { readonly isAvailable: () => boolean } | undefined;
  /** The local availability module: there from the build that added it. */
  readonly bridge: { readonly check: () => Promise<unknown> } | undefined;
}

/**
 * Whether the model can run and why not, for `status` and `availability`
 * alike. Generation needs the package, so without it nothing else matters.
 * The reason comes from the availability module; a binary built before it
 * falls back to the package's yes/no and says that this build cannot read
 * the reason, rather than guess one.
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
      return ai.isAvailable()
        ? { status: 'ready' }
        : { reasonsUnavailable: true, status: 'unavailable' };
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

/** The check against this binary's native modules, each loaded lazily. */
const deviceAvailability = (): Promise<ModelAvailability> =>
  checkAvailability({
    ai: loadModule()?.AppleFoundationModels,
    bridge: loadModelAvailabilityModule(),
  });

/**
 * Apple's on-device Foundation Models as the app's LanguageModel. Nothing
 * leaves the device and there is no per-request cost; the framework needs
 * iOS 26 on Apple Intelligence hardware, so `status` gates every entry
 * point rather than letting calls fail.
 */
export const appleLanguageModel: LanguageModel = {
  availability: deviceAvailability,
  generateJson: async ({ jsonSchema, prompt }) => {
    const module = loadModule();
    if (!module) {
      throw new Error('Apple foundation models are not built into this app.');
    }
    const parts = await withTimeout(
      module.AppleFoundationModels.generateText(
        [{ content: prompt, role: 'user' }],
        // Guided generation: the framework constrains decoding to the
        // schema, so the reply parses — though it can still be
        // semantically wrong, which is why the caller re-validates.
        { schema: jsonSchema as Record<string, unknown>, temperature: 0 },
      ),
      GENERATE_TIMEOUT_MS,
      'Generation timed out.',
    );
    const text = parts
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
