import type { SettingsImportSummary } from '@calendar/core';
import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { Footer } from '../GroupedList.tsx';
import { CodePasteField } from '../settingsCode/CodePasteField.tsx';
import { CodeScanner } from '../settingsCode/CodeScanner.tsx';
import { useCodeReader } from '../settingsCode/useCodeReader.ts';
import { useStyles } from '../theme.ts';
import { useSetup } from './SetupContext.tsx';
import { SetupButton, SetupNote, SetupPoint, SetupScreen } from './SetupScreen.tsx';

/**
 * The welcome's other door: a setup copied from the Mac by its settings
 * code — scanned from the Mac's screen, pasted (Universal Clipboard), or
 * handed in from outside (a share, the Camera app's "Open in Solunivo").
 * A settings file still imports from here. The import shows what it would
 * do first, as Settings File does; what came over, and what this iPhone
 * still has to do itself, is the next screen.
 */
export function SetupCopy() {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const { finish, setImported } = useSetup();
  const done = (summary: SettingsImportSummary) => {
    setImported(summary);
    router.push('/setup/copied');
  };
  const reader = useCodeReader(done);
  const pickFile = async () => {
    const summary = await reader.importSettings();
    if (summary) {
      done(summary);
    }
  };
  return (
    <SetupScreen
      actions={
        <>
          <SetupButton
            disabled={reader.busy}
            label="Import a settings file"
            onPress={() => void pickFile()}
            testID="setup-import-file"
            variant="quiet"
          />
          <SetupButton
            label="Set up by hand instead"
            onPress={() => router.replace('/setup/sources')}
            testID="setup-by-hand"
            variant="quiet"
          />
        </>
      }
      lead="On the Mac, open Solunivo › Settings › Settings File and show the code, then scan it here."
      onSkip={() => finish('skipped')}
      testID="setup-copy"
      title="Copy from your Mac"
    >
      <View style={styles.reader}>
        <CodeScanner onCode={reader.read} onStart={reader.reset} />
        <CodePasteField disabled={reader.busy} onCode={reader.read} />
      </View>
      {reader.notice ? <Footer testID="setup-copy-notice">{reader.notice}</Footer> : null}
      <View style={styles.points}>
        <SetupPoint>
          What comes over: accounts as a sign-in list, which calendars and lists are shown, time
          zones, alerts and birthday reminders.
        </SetupPoint>
        <SetupPoint>
          What never does: passwords and sign-in tokens. Each Google account signs in once here.
        </SetupPoint>
      </View>
      <SetupNote>
        An import never removes anything, and you see what it changes before it does.
      </SetupNote>
    </SetupScreen>
  );
}

const makeStyles = () =>
  StyleSheet.create({
    points: {
      gap: 10,
    },
    reader: {
      gap: 14,
    },
  });
