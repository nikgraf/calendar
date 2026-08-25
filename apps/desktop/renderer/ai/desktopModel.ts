import type { LanguageModel, ModelStatus } from '@calendar/ai';

/**
 * The desktop LanguageModel: Apple's on-device Foundation Models reached
 * through the bundled Swift helper (main process spawns it; calls travel
 * over preload IPC). The mirror of apps/ios/src/appleModel.ts, including
 * the degradation philosophy: a missing helper or an old macOS reports
 * unavailable instead of breaking the features built on the seam.
 */
export const desktopLanguageModel: LanguageModel = {
  generateJson: async ({ jsonSchema, prompt }) => {
    const result = await window.calendarBridge.modelGenerate(jsonSchema, prompt);
    return JSON.parse(result.json) as unknown;
  },
  status: async (): Promise<ModelStatus> => {
    try {
      const result = await window.calendarBridge.modelStatus();
      return result.status === 'ready' ? 'ready' : 'unavailable';
    } catch {
      return 'unavailable';
    }
  },
};
