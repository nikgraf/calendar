import type { useBackendMutations } from '@calendar/app-state';
import {
  formatSettingsDocument,
  parseSettingsDocument,
  type SettingsDocument,
  type SettingsImportSummary,
} from '@calendar/core';
import { decodeSettingsCode } from '@calendar/core/settingsCode';
import { Effect } from 'effect';

export const shortPath = (path: string): string => path.replace(/^\/Users\/[^/]+/, '~');

type Mutations = ReturnType<typeof useBackendMutations>;

/** Settings read from a file or a code, with what importing them would do; the person confirms next. */
export interface PendingImport {
  readonly document: SettingsDocument;
  /** What the preview names: the file's short path, or "these settings" for a code. */
  readonly source: string;
  readonly summary: SettingsImportSummary;
}

/**
 * Export: the settings document as a file, through the save dialog.
 * Resolves with the path it went to, or null when the dialog was
 * cancelled. Shared by Settings › Settings File and the "Set up your
 * iPhone" lesson.
 */
export const exportSettingsToFile = async (mutations: Mutations): Promise<string | null> => {
  const document = await mutations.exportSettings(undefined);
  const result = await window.calendarBridge.settingsFileSave(formatSettingsDocument(document));
  return 'canceled' in result ? null : result.path;
};

/**
 * Import, first half: the open dialog, the parse (a failure names the
 * file) and the preview. Resolves with nothing when the dialog was
 * cancelled; `importSettings` applies it once the person confirmed.
 * Shared by Settings › Settings File and the setup dialog's copy door.
 */
export const pickSettingsFile = async (mutations: Mutations): Promise<PendingImport | null> => {
  const opened = await window.calendarBridge.settingsFileOpen();
  if ('canceled' in opened) {
    return null;
  }
  const document = await Effect.runPromise(
    parseSettingsDocument(opened.text).pipe(
      Effect.mapError((error) => new Error(`${shortPath(opened.path)}: ${error.message}`)),
    ),
  );
  const summary = await mutations.previewSettingsImport({ document });
  return { document, source: shortPath(opened.path), summary };
};

/**
 * The same first half for a settings code (scanned or pasted): decode —
 * a failure says what is wrong with the code — and preview. Shared by the
 * code readers in Settings › Settings File, the setup dialog and the
 * calendar's ⌘V.
 */
export const readSettingsCode = async (
  mutations: Mutations,
  text: string,
): Promise<PendingImport> => {
  const document = await Effect.runPromise(
    decodeSettingsCode(text).pipe(Effect.mapError((error) => new Error(error.message))),
  );
  const summary = await mutations.previewSettingsImport({ document });
  return { document, source: 'these settings', summary };
};
