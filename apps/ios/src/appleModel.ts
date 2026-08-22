import type { LanguageModel } from '@calendar/ai';

/** Give up rather than leaving the UI stuck behind a stalled generation. */
const GENERATE_TIMEOUT_MS = 30_000;

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

const withTimeout = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Generation timed out.')), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Apple's on-device Foundation Models as the app's LanguageModel. Nothing
 * leaves the device and there is no per-request cost; the framework needs
 * iOS 26 on Apple Intelligence hardware, so `isAvailable` gates every
 * entry point rather than letting calls fail.
 */
export const appleLanguageModel: LanguageModel = {
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
  isAvailable: async () => {
    const module = loadModule();
    if (!module) {
      return false;
    }
    try {
      return module.AppleFoundationModels.isAvailable();
    } catch {
      return false;
    }
  },
};
