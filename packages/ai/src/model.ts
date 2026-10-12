import { Data } from 'effect';
/**
 * Why a model can or cannot run. A boolean conflated two very different
 * situations — "this build has no model at all" and "the model is there
 * but the OS says no right now" — which left the UI unable to say
 * anything useful, so it said nothing and hid itself.
 */
export type ModelStatus =
  /** Apple Intelligence is switched off in system settings; the user can turn it on. */
  | 'disabled'
  /** The native module is missing from this binary; nothing to wait for. */
  | 'missing-module'
  /** Switched on, but the system has not finished downloading the model. */
  | 'not-ready'
  /** Usable now. */
  | 'ready'
  /** Present, but the system reports it unavailable for no reason it names — often temporary. */
  | 'unavailable'
  /** This device or OS version cannot run the model at all. */
  | 'unsupported';

/**
 * The seam every AI feature talks to. Implementations are per-platform and
 * strictly on-device: Apple Foundation Models on iOS, and (later) a signed
 * helper binary on macOS. Nothing here imports platform code, so the
 * features built on top stay testable with a fake.
 */
/** What a provider's model can take: the pipelines size their input by it. */
export interface ModelInfo {
  /**
   * The tokens prompt and answer share, when the provider knows: Apple's
   * on-device model has about 4K, a served Gemma whatever context it was
   * started with. Undefined means "assume small".
   */
  readonly contextTokens?: number | undefined;
  /** The model as the provider names it ("Apple Intelligence", "gemma3:4b"). */
  readonly name: string;
}

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
  /** The model behind the seam, when the provider can say (capture sizes its text by it). */
  readonly info?: (() => Promise<ModelInfo>) | undefined;
  /**
   * Whether a model can actually run here, and if not, why — so callers
   * can explain the gap instead of silently dropping AI entry points.
   */
  readonly status: () => Promise<ModelStatus>;
}

/** No on-device model can run here; callers explain the gap instead of hiding the entry point. */
export class ModelUnavailableError extends Data.TaggedError('ModelUnavailableError')<{
  readonly message: string;
}> {}
