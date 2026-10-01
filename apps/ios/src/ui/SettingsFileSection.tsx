import { useBackendMutations } from '@calendar/app-state';
import {
  describeImportSummary,
  formatSettingsDocument,
  parseSettingsDocument,
} from '@calendar/core';
import { Effect } from 'effect';
import { useState } from 'react';
import { Alert, Pressable, Share, Text, View } from 'react-native';
import { sectionStyles } from './settingsShared.ts';

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
 * Export/Import of the settings document on the phone. Export writes the
 * file to the cache folder and hands it to the share sheet (AirDrop it to
 * the Mac, save it to Files); Import picks a file and shows what it would
 * do before applying. The document never contains tokens: a Google
 * account from another device shows up as "reconnect".
 */
export function SettingsFileSection() {
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
    <View style={sectionStyles.card} testID="settings-file">
      <Text style={sectionStyles.title}>Export & import</Text>
      <Text style={sectionStyles.meta}>
        Carry these settings to another iPhone or Mac as a file. It never contains passwords or
        tokens; a Google account from another device shows up as “reconnect” until you sign in.
      </Text>
      <Pressable
        disabled={busy}
        onPress={() => void exportSettings()}
        style={busy && sectionStyles.busy}
        testID="settings-file-export"
      >
        <Text style={[sectionStyles.action, { marginTop: 10 }]}>Export settings…</Text>
      </Pressable>
      <Pressable
        disabled={busy}
        onPress={() => void importSettings()}
        style={busy && sectionStyles.busy}
        testID="settings-file-import"
      >
        <Text style={[sectionStyles.action, { marginTop: 8 }]}>Import settings…</Text>
      </Pressable>
      {notice ? (
        <Text style={sectionStyles.meta} testID="settings-file-notice">
          {notice}
        </Text>
      ) : null}
    </View>
  );
}
