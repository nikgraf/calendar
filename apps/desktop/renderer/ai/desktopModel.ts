import { APPLE_REASON_STATUS, type LanguageModel, type ModelStatus } from '@calendar/ai';
import type { ModelStatusReply } from '../backend.ts';

/**
 * The helper's `detail` when the model is unavailable: Foundation Models'
 * own reason or `osTooOld` from the helper below macOS 26 (the table iOS
 * reads too); and a served model's (modelProvider.ts): the server not
 * reachable, or the model not on it — the latter re-polled like a
 * download, since a pull ends while the app is in front. Anything else —
 * `helperUnavailable` from main, a reason a newer macOS adds — stays the
 * generic 'unavailable'.
 */
const STATUS_BY_DETAIL: ReadonlyMap<string, ModelStatus> = new Map<string, ModelStatus>([
  ...APPLE_REASON_STATUS,
  ['authRejected', 'unavailable'],
  ['endpointUnreachable', 'unavailable'],
  ['modelMissing', 'not-ready'],
]);

/** The helper's `status` reply as the shared ModelStatus. */
export const modelStatusOf = (result: { detail?: string; status: string }): ModelStatus =>
  result.status === 'ready'
    ? 'ready'
    : (STATUS_BY_DETAIL.get(result.detail ?? '') ?? 'unavailable');

let lastReply: ModelStatusReply | null = null;

/**
 * The last status reply in full — who answered and, for a served model,
 * where — so the AI entry points can say which provider is unavailable
 * (`modelUnavailableCopy`) without a second round trip.
 */
export const lastModelStatusReply = (): ModelStatusReply | null => lastReply;

/**
 * The desktop LanguageModel: the active provider in the main process —
 * Apple's on-device Foundation Models through the bundled Swift helper,
 * or a model served over HTTP (Settings › AI Model) — reached over preload
 * IPC. The mirror of apps/ios/src/appleModel.ts, including the
 * degradation philosophy: a missing helper, an old macOS or a server that
 * is down reports unavailable instead of breaking the features built on
 * the seam.
 */
export const desktopLanguageModel: LanguageModel = {
  generateJson: async ({ jsonSchema, prompt }) => {
    const result = await window.calendarBridge.modelGenerate(jsonSchema, prompt);
    return JSON.parse(result.json) as unknown;
  },
  info: () => window.calendarBridge.modelInfo(),
  status: async (): Promise<ModelStatus> => {
    try {
      const reply = await window.calendarBridge.modelStatus();
      lastReply = reply;
      return modelStatusOf(reply);
    } catch {
      lastReply = null;
      return 'unavailable';
    }
  },
};
