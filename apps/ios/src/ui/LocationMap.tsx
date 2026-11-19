import { type EventPlace } from '@calendar/app-state';
import { isMappableLocation, locationDirectionsUrls } from '@calendar/core';
import { SymbolView } from 'expo-symbols';
import {
  Linking,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { actionText, type ThemeColors, useStyles, useTheme } from './theme.ts';

/**
 * expo-maps' Apple Maps view is SwiftUI Map. Its module throws at import on
 * a binary built without the native dependency (a dev client from before
 * this feature), so it is required lazily and a failure leaves the
 * links available, like loadGeoModule.
 */
const loadAppleMaps = (): typeof import('expo-maps').AppleMaps | undefined => {
  if (Platform.OS !== 'ios') {
    return undefined;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy load
    return (require('expo-maps') as typeof import('expo-maps')).AppleMaps;
  } catch {
    return undefined;
  }
};
/** Apple Maps' SwiftUI view, or none on this binary (`loadAppleMaps`). */
export const AppleMaps = loadAppleMaps();

/**
 * A small Apple Maps view of the event's place with a marker, plus an
 * Open in Maps link in the editor, or Apple / Google directions links in
 * event details. Directions stay available before a lookup finishes or
 * when it fails. A tap on the map opens Apple Maps.
 */
export function LocationMap({
  place,
  variant = 'editor',
}: {
  place: EventPlace;
  variant?: 'editor' | 'detail';
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const { fontScale } = useWindowDimensions();
  const { location, mapGeo, mapLoading, mapsUrl } = place;
  if (!isMappableLocation(location)) {
    return null;
  }
  if (variant === 'editor' && !mapGeo && !mapLoading) {
    return null;
  }
  const directions = variant === 'detail' ? locationDirectionsUrls(location, mapGeo) : undefined;
  const coordinates = mapGeo ? { latitude: mapGeo.lat, longitude: mapGeo.lng } : undefined;
  const open = () => mapsUrl && void Linking.openURL(mapsUrl);
  return (
    <View style={[styles.container, variant === 'editor' && styles.editorInset]}>
      {AppleMaps && coordinates && mapGeo ? (
        <Pressable
          accessibilityLabel={`Open ${mapGeo.name ?? location} in Maps`}
          accessibilityRole="button"
          onPress={open}
          style={styles.map}
          testID="location-map"
        >
          <View pointerEvents="none" style={StyleSheet.absoluteFill}>
            <AppleMaps.View
              cameraPosition={{ coordinates, zoom: 15 }}
              markers={[{ coordinates, title: mapGeo.name ?? location }]}
              properties={{ isMyLocationEnabled: false, selectionEnabled: false }}
              style={StyleSheet.absoluteFill}
              uiSettings={{
                compassEnabled: false,
                myLocationButtonEnabled: false,
                scaleBarEnabled: false,
                togglePitchEnabled: false,
              }}
            />
          </View>
        </Pressable>
      ) : mapLoading ? (
        <View style={[styles.map, styles.placeholder]}>
          <Text style={styles.placeholderLabel}>Locating…</Text>
        </View>
      ) : null}
      {directions ? (
        <View style={styles.directionGroup}>
          <Text style={styles.directionCaption}>Get directions</Text>
          <View style={styles.directions}>
            {(
              [
                { id: 'apple', label: 'Apple Maps', url: directions.apple },
                { id: 'google', label: 'Google Maps', url: directions.google },
              ] as const
            ).map(({ id, label, url }) => (
              <Pressable
                accessibilityLabel={`Get directions in ${label}`}
                accessibilityRole="link"
                key={id}
                onPress={() => void Linking.openURL(url)}
                style={({ pressed }) => [
                  styles.directionButton,
                  { flexBasis: 140 * fontScale },
                  pressed && styles.directionPressed,
                ]}
                testID={`${id}-maps-directions`}
              >
                <Text style={styles.directionLabel}>{label}</Text>
                <SymbolView
                  accessible={false}
                  name="arrow.up.right"
                  size={13}
                  tintColor={colors.text}
                  weight="semibold"
                />
              </Pressable>
            ))}
          </View>
        </View>
      ) : mapsUrl ? (
        <Pressable accessibilityRole="link" hitSlop={8} onPress={open} testID="open-in-maps">
          <Text style={styles.link}>Open in Maps</Text>
        </Pressable>
      ) : null}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    container: {
      gap: 6,
      marginTop: 8,
    },
    directionButton: {
      alignItems: 'center',
      backgroundColor: colors.fill,
      borderRadius: 999,
      flexDirection: 'row',
      flexGrow: 1,
      gap: 8,
      justifyContent: 'center',
      maxWidth: '100%',
      minHeight: 48,
      paddingHorizontal: 16,
      paddingVertical: 12,
    },
    directionCaption: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
    directionGroup: {
      gap: 8,
      marginTop: 6,
    },
    directionLabel: {
      color: colors.text,
      flexShrink: 1,
      fontSize: 15,
      fontWeight: '600',
      textAlign: 'center',
    },
    directionPressed: {
      backgroundColor: colors['border-strong'],
    },
    directions: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 8,
    },
    // Align the editor's map with the location card above it.
    editorInset: {
      marginHorizontal: 16,
      marginTop: 12,
    },
    link: {
      ...actionText(colors),
      fontSize: 14,
    },
    map: {
      borderRadius: 16,
      height: 160,
      overflow: 'hidden',
    },
    placeholder: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      justifyContent: 'center',
    },
    placeholderLabel: {
      color: colors['text-secondary'],
      fontSize: 13,
    },
  });
