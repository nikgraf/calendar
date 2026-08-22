import type { LanguageModel } from '@calendar/ai';
import { AppleFoundationModels } from '@react-native-ai/apple';

/**
 * Apple's on-device Foundation Models as the app's LanguageModel. Nothing
 * leaves the device and there is no per-request cost; the framework is
 * iOS 26+ on Apple Intelligence hardware, so `isAvailable` gates every
 * entry point rather than letting calls fail.
 */
export const appleLanguageModel: LanguageModel = {
  generateJson: async ({ jsonSchema, prompt }) => {
    const parts = await AppleFoundationModels.generateText(
      [{ content: prompt, role: 'user' }],
      // Guided generation: the framework constrains decoding to the schema,
      // so the reply parses — though it can still be semantically wrong,
      // which is why the caller re-validates.
      { schema: jsonSchema as Record<string, unknown>, temperature: 0 },
    );
    const text = parts
      .filter((part): part is { text: string; type: 'text' } => part.type === 'text')
      .map((part) => part.text)
      .join('');
    return JSON.parse(text) as unknown;
  },
  isAvailable: async () => {
    try {
      return AppleFoundationModels.isAvailable();
    } catch {
      // Older runtimes lack the native module entirely.
      return false;
    }
  },
};
