import type { DesktopSettings } from '@calendar/core';
import { Context, Effect, Layer } from 'effect';

/**
 * Settings a host keeps outside the database — today the desktop's screen
 * privacy mode, owned by the Electron main process. The shared export and
 * import go through this seam so the document carries the section on the
 * platform that has it and ignores it on the one that does not.
 */
export interface PlatformSettingsShape {
  /** Applies the section; a host without the setting ignores it. */
  readonly apply: (section: DesktopSettings) => Effect.Effect<void>;
  /** The current values, or `{}` on a host without them (the section is then omitted from an export). */
  readonly read: Effect.Effect<DesktopSettings>;
}

export class PlatformSettings extends Context.Service<PlatformSettings, PlatformSettingsShape>()(
  'sync/PlatformSettings',
) {
  /** A host with no platform-held settings (iOS, tests). */
  static readonly none: Layer.Layer<PlatformSettings> = Layer.succeed(PlatformSettings, {
    apply: () => Effect.void,
    read: Effect.succeed({}),
  });
}
