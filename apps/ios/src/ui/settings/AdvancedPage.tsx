import { useBackendMutations } from '@calendar/app-state';
import {
  describeImportSummary,
  formatSettingsDocument,
  parseSettingsDocument,
} from '@calendar/core';
import { Effect } from 'effect';
import { useState } from 'react';
import { Alert, Share } from 'react-native';
import { useTheme } from '../theme.ts';
import { Footer, Glyph, NavRow, Row, Section, SettingsPage } from './GroupedList.tsx';

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

/**
 * Advanced: the settings file and troubleshooting. Export writes the
 * settings document to the cache folder and hands it to the share sheet
 * (AirDrop it to the Mac, save it to Files); Import picks a file and shows
 * what it would do before applying. The document never contains tokens: a
 * Google account from another device shows up as "reconnect".
 */
export function AdvancedPage() {
  const { colors } = useTheme();
  const mutations = useBackendMutations();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const run = async (task: () => Promise<string | null>) => {
    setBusy(true);
    setNotice(null);
    try {
      setNotice(await task());
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  };

  const exportSettings = () =>
    run(async () => {
      const native = load();
      if (!native) {
        return 'Exporting needs a newer app build.';
      }
      const document = await mutations.exportSettings(undefined);
      const file = new native.files.File(native.files.Paths.cache, FILE_NAME);
      file.write(formatSettingsDocument(document));
      await Share.share({ title: FILE_NAME, url: file.uri });
      return null;
    });

  const importSettings = () =>
    run(async () => {
      const native = load();
      if (!native) {
        return 'Importing needs a newer app build.';
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
        return null;
      }
      const text = await new native.files.File(asset.uri).text();
      const document = await Effect.runPromise(
        parseSettingsDocument(text).pipe(
          Effect.mapError((error) => new Error(`${asset.name}: ${error.message}`)),
        ),
      );
      const preview = await mutations.previewSettingsImport({ document });
      if (!(await confirmImport(describeImportSummary(preview)))) {
        return null;
      }
      const summary = await mutations.importSettings({ document });
      return `Imported ${asset.name}. ${describeImportSummary(summary).join(' ')}`;
    });

  return (
    <SettingsPage testID="settings-page-advanced">
      <Section
        footer={
          <>
            <Footer>
              Carry these settings to another iPhone or Mac as a file. It never contains passwords
              or tokens; a Google account from another device shows up as “reconnect” until you sign
              in. An import never removes anything.
            </Footer>
            {notice ? <Footer testID="settings-file-notice">{notice}</Footer> : null}
          </>
        }
        header="Settings File"
        testID="settings-file"
      >
        <Row
          accessory={<Glyph name="square.and.arrow.up" size={18} tintColor={colors.primary} />}
          disabled={busy}
          onPress={() => void exportSettings()}
          testID="settings-file-export"
          title="Export Settings…"
          tone="tint"
        />
        <Row
          accessory={<Glyph name="square.and.arrow.down" size={18} tintColor={colors.primary} />}
          disabled={busy}
          onPress={() => void importSettings()}
          testID="settings-file-import"
          title="Import Settings…"
          tone="tint"
        />
      </Section>

      <Section
        footer="PR Preview loads a pull request’s update into a TestFlight build."
        header="Troubleshooting"
      >
        <NavRow
          href="/settings/diagnostics"
          testID="settings-row-diagnostics"
          title="Diagnostics"
        />
        <NavRow href="/settings/pr-preview" testID="settings-row-pr-preview" title="PR Preview" />
      </Section>
    </SettingsPage>
  );
}
