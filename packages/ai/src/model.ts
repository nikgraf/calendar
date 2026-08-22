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
   * Whether a model can actually run here — false on hardware or OS
   * versions without on-device support, so callers can hide AI entry
   * points rather than offer something that will fail.
   */
  readonly isAvailable: () => Promise<boolean>;
}

export class ModelUnavailableError extends Error {
  override readonly name = 'ModelUnavailableError';
}
