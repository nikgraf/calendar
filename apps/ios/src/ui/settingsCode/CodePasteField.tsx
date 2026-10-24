import { extractSettingsCode } from '@calendar/core/settingsCode';
import { useState } from 'react';
import { StyleSheet, Text, TextInput, View } from 'react-native';
import { type ThemeColors, useStyles, useTheme } from '../theme.ts';

/**
 * A field to paste a settings code into (the Mac's "Copy as text",
 * through Universal Clipboard). Pasting into a field is the person's own
 * act, so iOS shows no "Allow Paste" prompt — reading the clipboard from
 * code would. A code anywhere in what lands reads at once; Return on
 * anything else says it is not a code.
 */
export function CodePasteField({
  disabled = false,
  onCode,
}: {
  disabled?: boolean;
  onCode: (code: string) => void;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const [text, setText] = useState('');
  const [notCode, setNotCode] = useState(false);
  return (
    <View style={styles.wrap}>
      <TextInput
        accessibilityLabel="Paste a code"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!disabled}
        onChangeText={(value) => {
          setText(value);
          setNotCode(false);
          const code = extractSettingsCode(value);
          if (code) {
            onCode(code);
          }
        }}
        onSubmitEditing={() => setNotCode(text.trim() !== '' && !extractSettingsCode(text))}
        placeholder="Paste a code"
        placeholderTextColor={colors['text-secondary']}
        returnKeyType="done"
        smartInsertDelete={false}
        spellCheck={false}
        style={styles.field}
        testID="code-paste"
        value={text}
      />
      {notCode ? (
        <Text style={styles.error} testID="code-paste-error">
          That isn’t a Solunivo code.
        </Text>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    error: {
      color: colors.danger,
      fontSize: 13,
    },
    field: {
      backgroundColor: colors['surface-raised'],
      borderRadius: 10,
      color: colors.text,
      fontSize: 15,
      paddingHorizontal: 12,
      paddingVertical: 10,
    },
    wrap: {
      gap: 6,
    },
  });
