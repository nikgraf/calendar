import type { LanguageModel, ModelStatus } from '@calendar/ai';

/**
 * The helper's `detail` when the model is unavailable: Foundation Models'
 * own reason (`SystemLanguageModel.Availability.UnavailableReason`,
 * stringified), or `osTooOld` from the helper below macOS 26. Anything
 * else — `helperUnavailable` from main, a reason a newer macOS adds —
 * stays the generic 'unavailable'.
 */
const STATUS_BY_DETAIL: ReadonlyMap<string, ModelStatus> = new Map<string, ModelStatus>([
  ['appleIntelligenceNotEnabled', 'disabled'],
  ['deviceNotEligible', 'unsupported'],
  ['modelNotReady', 'not-ready'],
  ['osTooOld', 'unsupported'],
]);

/** The helper's `status` reply as the shared ModelStatus. */
export const modelStatusOf = (result: { detail?: string; status: string }): ModelStatus =>
  result.status === 'ready'
    ? 'ready'
    : (STATUS_BY_DETAIL.get(result.detail ?? '') ?? 'unavailable');

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
      return modelStatusOf(await window.calendarBridge.modelStatus());
    } catch {
      return 'unavailable';
    }
  },
};
