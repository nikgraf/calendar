import { Pressable, Text } from 'react-native';
import { useSheetStyles } from './editSheetShared.ts';
import { BOX_FONT_SCALE } from './theme.ts';

/** The same 44 pt capsule for every sheet's Close, Cancel, Edit, Done and Save. */
export function SheetButton({
  busy = false,
  disabled = false,
  label,
  onPress,
  primary = false,
  testID,
}: {
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly label: string;
  readonly onPress: () => void;
  readonly primary?: boolean;
  readonly testID: string;
}) {
  const styles = useSheetStyles();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ busy, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.capsule, primary && styles.capsulePrimary, (busy || disabled) && styles.busy]}
      testID={testID}
    >
      <Text
        maxFontSizeMultiplier={BOX_FONT_SCALE}
        style={[styles.capsuleLabel, primary && styles.capsulePrimaryLabel]}
      >
        {label}
      </Text>
    </Pressable>
  );
}
