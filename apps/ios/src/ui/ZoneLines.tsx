import { type StyleProp, Text, type TextStyle, View } from 'react-native';
import { useTheme, zoneColor } from './theme.ts';

/** An event's times in the other zones, one line each, in the gutter's order and shades. */
export function ZoneLines({
  lines,
  textStyle,
}: {
  lines: ReadonlyArray<string>;
  textStyle: StyleProp<TextStyle>;
}) {
  const { colors } = useTheme();
  return (
    <View testID="event-secondary-times">
      {lines.map((line, index) => (
        <Text key={line} style={[textStyle, { color: zoneColor(colors, index + 1) }]}>
          {line}
        </Text>
      ))}
    </View>
  );
}
