import { useBackendMutations } from '@calendar/app-state';
import {
  describeImportSummary,
  formatSettingsDocument,
  parseSettingsDocument,
  type SettingsImportSummary,
} from '@calendar/core';
import { decodeSettingsCode } from '@calendar/core/settingsCode';
import { Effect } from 'effect';
import { useState } from 'react';
import { Alert, Share } from 'react-native';

/**
 * Native modules are loaded lazily and inside a try: a static import of a
 * module whose pod is missing crashes the app at launch on a binary built
 * before this feature — which is what an OTA preview runs on. See
 * appleSpeech.ts for the same rule.
 */
const load = () => {
  try {
    /* eslint-disable typescript/no-require-imports -- deliberate: see above */
    return {
      files: require('expo-file-system') as typeof import('expo-file-system'),
      picker: require('expo-document-picker') as typeof import('expo-document-picker'),
    };
    /* eslint-enable typescript/no-require-imports */
  } catch {
    return undefined;
  }
};

const FILE_NAME = 'solunivo.jsonc';

/** The preview as a native alert; resolves with the person's choice. */
const confirmImport = (lines: ReadonlyArray<string>) =>
  new Promise<boolean>((resolve) => {
    Alert.alert('Import settings?', `${lines.join('\n')}\n\nNothing is removed by an import.`, [
      { onPress: () => resolve(false), style: 'cancel', text: 'Cancel' },
      { onPress: () => resolve(true), text: 'Import' },
    ]);
  });

export interface SettingsTransfer {
  readonly busy: boolean;
  /**
   * The settings document as a file, handed to the share sheet: whether
   * it went somewhere (false when the sheet was dismissed or it failed).
   */
  readonly exportSettings: () => Promise<boolean>;
  /**
   * A settings code (scanned, pasted, shared, or opened from the Camera
   * app): decoded, previewed as the same alert, imported. What it did, or
   * null when the alert was cancelled or the code would not read — the
   * notice then says why.
   */
  readonly importCode: (text: string) => Promise<SettingsImportSummary | null>;
  /**
   * The document picker, the preview as an alert, then the import: what it
   * did, or null when the picker or the alert was cancelled.
   */
  readonly importSettings: () => Promise<SettingsImportSummary | null>;
  /** What the last action said: a result, or why it failed. */
  readonly notice: string | null;
}

/**
 * Export and Import of the settings document on this iPhone, and the
 * import of a settings code, shared by Settings › Settings File, the
 * setup's "Copy from your Mac" door and the "Set up your Mac" lesson.
 * The document never contains tokens: a Google account from another
 * device shows up as "Sign in" until it signs in here.
 */
export const useSettingsTransfer = (): SettingsTransfer => {
  const mutations = useBackendMutations();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async <A>(
    task: () => Promise<{ readonly notice: string | null; readonly result: A }>,
  ) => {
    setBusy(true);
    setNotice(null);
    try {
      const outcome = await task();
      setNotice(outcome.notice);
      return outcome.result;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
      return null;
    } finally {
      setBusy(false);
    }
  };

  const exportSettings = async () =>
    (await run(async () => {
      const native = load();
      if (!native) {
        return { notice: 'Exporting needs a newer app build.', result: false };
      }
      const document = await mutations.exportSettings(undefined);
      const file = new native.files.File(native.files.Paths.cache, FILE_NAME);
      file.write(formatSettingsDocument(document));
      const shared = await Share.share({ title: FILE_NAME, url: file.uri });
      return { notice: null, result: shared.action === Share.sharedAction };
    })) === true;

  const importSettings = () =>
    run<SettingsImportSummary | null>(async () => {
      const native = load();
      if (!native) {
        return { notice: 'Importing needs a newer app build.', result: null };
      }
      const picked = await native.picker.getDocumentAsync({
        copyToCacheDirectory: true,
        multiple: false,
        // MIME types, not UTIs; .jsonc has none of its own, so accept any
        // file and let the parser judge the contents.
        type: '*/*',
      });
      const asset = picked.canceled ? undefined : picked.assets[0];
      if (!asset) {
        return { notice: null, result: null };
      }
      const text = await new native.files.File(asset.uri).text();
      const document = await Effect.runPromise(
        parseSettingsDocument(text).pipe(
          Effect.mapError((error) => new Error(`${asset.name}: ${error.message}`)),
        ),
      );
      const preview = await mutations.previewSettingsImport({ document });
      if (!(await confirmImport(describeImportSummary(preview)))) {
        return { notice: null, result: null };
      }
      const summary = await mutations.importSettings({ document });
      return {
        notice: `Imported ${asset.name}. ${describeImportSummary(summary).join(' ')}`,
        result: summary,
      };
    });

  const importCode = (text: string) =>
    run<SettingsImportSummary | null>(async () => {
      const document = await Effect.runPromise(
        decodeSettingsCode(text).pipe(Effect.mapError((error) => new Error(error.message))),
      );
      const preview = await mutations.previewSettingsImport({ document });
      if (!(await confirmImport(describeImportSummary(preview)))) {
        return { notice: null, result: null };
      }
      const summary = await mutations.importSettings({ document });
      return {
        notice: `Imported the code. ${describeImportSummary(summary).join(' ')}`,
        result: summary,
      };
    });

  return { busy, exportSettings, importCode, importSettings, notice };
};
