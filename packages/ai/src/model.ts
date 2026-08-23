/**
 * Why a model can or cannot run. A boolean conflated two very different
 * situations — "this build has no model at all" and "the model is there
 * but the OS says no right now" — which left the UI unable to say
 * anything useful, so it said nothing and hid itself.
 */
export type ModelStatus =
  /** The native module is missing from this binary; nothing to wait for. */
  | 'missing-module'
  /** Usable now. */
  | 'ready'
  /** Present, but the system reports it unavailable — often temporary. */
  | 'unavailable';

/**
 * The seam every AI feature talks to. Implementations are per-platform and
 * strictly on-device: Apple Foundation Models on iOS, and (later) a signed
 * helper binary on macOS. Nothing here imports platform code, so the
 * features built on top stay testable with a fake.
 */
export interface LanguageModel {
  /**
   * Generates JSON matching `jsonSchema`. Implementations use guided
   * generation where available; callers must still validate, because a
   * schema-shaped response can be semantically wrong.
   */
  readonly generateJson: (request: {
    readonly jsonSchema: unknown;
    readonly prompt: string;
  }) => Promise<unknown>;
  /**
   * Whether a model can actually run here, and if not, why — so callers
   * can explain the gap instead of silently dropping AI entry points.
   */
  readonly status: () => Promise<ModelStatus>;
}

export class ModelUnavailableError extends Error {
  override readonly name = 'ModelUnavailableError';
}
