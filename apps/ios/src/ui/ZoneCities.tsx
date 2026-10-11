import { zoneCity, zoneSlug } from '@calendar/core';
import { StyleSheet, Text, View } from 'react-native';
import { BOX_FONT_SCALE, useTheme, zoneColor } from './theme.ts';

/**
 * Which zone each line under an hour is: the cities over the hour gutter,
 * in the lines' order and shades, the primary on top. A long name shrinks
 * a little, then truncates.
 */
export function ZoneCities({ width, zones }: { width: number; zones: ReadonlyArray<string> }) {
  const { colors } = useTheme();
  return (
    <View style={[styles.column, { width }]} testID="zone-cities">
      {zones.map((zone, index) => (
        <Text
          adjustsFontSizeToFit
          key={zone}
          maxFontSizeMultiplier={BOX_FONT_SCALE}
          minimumFontScale={0.8}
          numberOfLines={1}
          style={[index === 0 ? styles.primary : styles.other, { color: zoneColor(colors, index) }]}
          testID={`zone-city-${zoneSlug(zone)}`}
        >
          {zoneCity(zone)}
        </Text>
      ))}
    </View>
  );
}

// Right edge and sizes match the hour labels under it (DayTimeline's
// `hourLabels`, 12 pt short of the gutter's edge).
const styles = StyleSheet.create({
  column: {
    justifyContent: 'center',
    paddingLeft: 4,
    paddingRight: 12,
  },
  other: {
    fontSize: 8,
    textAlign: 'right',
  },
  primary: {
    fontSize: 10,
    textAlign: 'right',
  },
});
