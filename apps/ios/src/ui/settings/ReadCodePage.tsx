import { describeImportSummary } from '@calendar/core';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { Footer, RowSlot, Section, SettingsPage } from '../GroupedList.tsx';
import { CodePasteField } from '../settingsCode/CodePasteField.tsx';
import { CodeScanner } from '../settingsCode/CodeScanner.tsx';
import { useCodeReader } from '../settingsCode/useCodeReader.ts';
import { type ThemeColors, useStyles } from '../theme.ts';

/**
 * Settings › Settings File › Read Code from Your Mac: the reader outside
 * the first run — scan the Mac's code, paste it, or land here with one
 * shared into the app or opened from the Camera app. The same alert
 * previews it; what was applied stays on the page.
 */
export function ReadCodePage() {
  const styles = useStyles(makeStyles);
  const [applied, setApplied] = useState<ReadonlyArray<string> | null>(null);
  const reader = useCodeReader((summary) => setApplied(describeImportSummary(summary)));
  return (
    <SettingsPage testID="settings-page-read-code">
      <Section footer="On the Mac, open Solunivo › Settings › Settings File and choose Show Code.">
        <RowSlot>
          <View style={styles.reader}>
            <CodeScanner onCode={reader.read} onStart={reader.reset} />
            <CodePasteField disabled={reader.busy} onCode={reader.read} />
          </View>
        </RowSlot>
      </Section>
      {applied ? (
        <Section
          footer="A Google account from the code waits for a sign-in under Accounts."
          header="Copied"
        >
          <RowSlot testID="read-code-applied">
            {applied.map((line) => (
              <Text key={line} style={styles.line}>
                {line}
              </Text>
            ))}
          </RowSlot>
        </Section>
      ) : reader.notice ? (
        <Footer testID="read-code-notice">{reader.notice}</Footer>
      ) : null}
    </SettingsPage>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    line: {
      color: colors.text,
      fontSize: 15,
      lineHeight: 22,
    },
    reader: {
      gap: 14,
      paddingVertical: 4,
    },
  });
