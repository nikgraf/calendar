import { useRouter } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { Footer } from '../GroupedList.tsx';
import { useSettingsTransfer } from '../settings/useSettingsTransfer.ts';
import { useStyles } from '../theme.ts';
import { useSetup } from './SetupContext.tsx';
import { SetupButton, SetupNote, SetupPoint, SetupScreen } from './SetupScreen.tsx';

/**
 * The welcome's other door: a setup copied from the Mac as its settings
 * file (Settings › Settings File › Export… there, AirDropped here). The
 * import shows what it would do first, as Settings File does; what came
 * over, and what this iPhone still has to do itself, is the next screen.
 */
export function SetupCopy() {
  const styles = useStyles(makeStyles);
  const router = useRouter();
  const { finish, setImported } = useSetup();
  const { busy, importSettings, notice } = useSettingsTransfer();
  const pick = async () => {
    const summary = await importSettings();
    if (summary) {
      setImported(summary);
      router.push('/setup/copied');
    }
  };
  return (
    <SetupScreen
      actions={
        <>
          <SetupButton
            disabled={busy}
            label={busy ? 'Importing…' : 'Import a settings file'}
            onPress={() => void pick()}
            testID="setup-import-file"
          />
          <SetupButton
            label="Set up by hand instead"
            onPress={() => router.replace('/setup/sources')}
            testID="setup-by-hand"
            variant="quiet"
          />
        </>
      }
      lead="Bring the Mac’s settings over as a file, and this iPhone starts from them."
      onSkip={() => finish('skipped')}
      testID="setup-copy"
      title="Copy from your Mac"
    >
      <View style={styles.points}>
        <SetupPoint>
          On the Mac, open Settings › Settings File and choose Export…, then AirDrop the file to
          this iPhone and open it in Files.
        </SetupPoint>
        <SetupPoint>
          What comes over: accounts as a sign-in list, which calendars and lists are shown, time
          zones, alerts and birthday reminders.
        </SetupPoint>
        <SetupPoint>
          What never does: passwords and sign-in tokens. Each Google account signs in once here.
        </SetupPoint>
      </View>
      {notice ? <Footer testID="setup-copy-notice">{notice}</Footer> : null}
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
  });
