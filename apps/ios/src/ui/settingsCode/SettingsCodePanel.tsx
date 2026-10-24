import { useSettingsCode } from '@calendar/app-state';
import { useState } from 'react';
import { Share, StyleSheet, Text, View } from 'react-native';
import { Footer, Glyph, Row, RowSlot, Section } from '../GroupedList.tsx';
import { type ThemeColors, useStyles, useTheme } from '../theme.ts';
import { SettingsCodeImage } from './SettingsCodeImage.tsx';

/**
 * Lazily, inside a try: an OTA preview may run on a binary built before
 * expo-clipboard was in it (see useSettingsTransfer's `load`). Without it,
 * the text goes to the share sheet, whose Copy does the same.
 */
const loadClipboard = () => {
  try {
    // eslint-disable-next-line typescript/no-require-imports -- deliberate: see above
    return require('expo-clipboard') as typeof import('expo-clipboard');
  } catch {
    return undefined;
  }
};

/**
 * This iPhone's settings as a code for the Mac to read: the QR, what it
 * carries, and its text to copy (Universal Clipboard takes it to the Mac,
 * where ⌘V reads it). With `reveal`, the code waits behind Show Code —
 * it holds account addresses and calendar choices — and `onTried` hears
 * the reveal or the copy: the lesson's "tried".
 */
export function SettingsCodePanel({
  onTried,
  reveal,
}: {
  onTried?: (() => void) | undefined;
  reveal: boolean;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const view = useSettingsCode();
  const [shown, setShown] = useState(!reveal);
  const [notice, setNotice] = useState<string | null>(null);

  const copy = async () => {
    if (!view) {
      return;
    }
    const clipboard = loadClipboard();
    if (clipboard) {
      await clipboard.setStringAsync(view.code);
      setNotice('Copied. Paste it on the Mac — Universal Clipboard carries it over.');
    } else {
      await Share.share({ message: view.code });
    }
    onTried?.();
  };

  if (!shown) {
    return (
      <Section footer="The code holds account addresses and calendar choices — never passwords or tokens.">
        <Row
          accessory={<Glyph name="qrcode" size={18} tintColor={colors.primary} />}
          onPress={() => {
            setShown(true);
            onTried?.();
          }}
          testID="settings-code-show"
          title="Show Code"
          tone="tint"
        />
      </Section>
    );
  }
  return (
    <>
      <Section footer="Read it with Solunivo on the Mac, not the Camera app: a plain QR there offers to search the web for its text.">
        <RowSlot testID="settings-code">
          <View style={styles.code}>
            {view === null ? (
              <Text style={styles.waiting}>Reading these settings…</Text>
            ) : view.qr ? (
              <SettingsCodeImage qr={view.qr} width={260} />
            ) : (
              <Text style={styles.waiting} testID="settings-code-too-large">
                This setup is too large for one code. Copy it as text, or use Export Settings…
                instead.
              </Text>
            )}
          </View>
        </RowSlot>
      </Section>
      {view && view.lines.length > 0 ? (
        <Section header="In the code">
          <RowSlot testID="settings-code-lines">
            {view.lines.map((line) => (
              <Text key={line} style={styles.line}>
                {line}
              </Text>
            ))}
          </RowSlot>
        </Section>
      ) : null}
      <Section
        footer={notice ? <Footer testID="settings-code-notice">{notice}</Footer> : undefined}
      >
        <Row
          accessory={<Glyph name="doc.on.doc" size={18} tintColor={colors.primary} />}
          disabled={view === null}
          onPress={() => void copy()}
          testID="settings-code-copy"
          title="Copy as Text"
          tone="tint"
        />
      </Section>
    </>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    code: {
      alignItems: 'center',
      paddingVertical: 8,
    },
    line: {
      color: colors.text,
      fontSize: 15,
      lineHeight: 22,
    },
    waiting: {
      color: colors['text-secondary'],
      fontSize: 15,
      textAlign: 'center',
    },
  });
