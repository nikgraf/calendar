import { type useEventEditorModel } from '@calendar/app-state';
import { isMappableLocation } from '@calendar/core';
import { Linking, Platform, Pressable, StyleSheet, Text, View } from 'react-native';

/**
 * expo-maps' Apple Maps view is SwiftUI Map, available from iOS 17 — and
 * its module throws at import on a binary built without the native
 * dependency (a dev client from before this feature), so it is required
 * lazily and a failure degrades to the link, like loadGeoModule.
 */
const loadAppleMaps = (): typeof import('expo-maps').AppleMaps | undefined => {
  if (Platform.OS !== 'ios' || Number.parseInt(String(Platform.Version), 10) < 17) {
    return undefined;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- deliberate lazy load
    return (require('expo-maps') as typeof import('expo-maps')).AppleMaps;
  } catch {
    return undefined;
  }
};
const AppleMaps = loadAppleMaps();

/**
 * A small Apple Maps view of the event's place with a marker, plus an
 * Open in Maps link. Not interactive inside the sheet — a tap on the map
 * opens the Maps app, which is where directions live anyway. Below iOS 17
 * only the link shows.
 */
export function LocationMap({ model }: { model: ReturnType<typeof useEventEditorModel> }) {
  const { location, mapGeo, mapLoading, mapsUrl } = model;
  if (!isMappableLocation(location)) {
    return null;
  }
  if (!mapGeo || !mapsUrl) {
    return mapLoading ? (
      <View style={[styles.map, styles.placeholder]}>
        <Text style={styles.placeholderLabel}>Locating…</Text>
      </View>
    ) : null;
  }
  const coordinates = { latitude: mapGeo.lat, longitude: mapGeo.lng };
  const open = () => void Linking.openURL(mapsUrl);
  return (
    <View style={styles.container}>
      {AppleMaps ? (
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
      ) : null}
      <Pressable accessibilityRole="link" hitSlop={8} onPress={open} testID="open-in-maps">
        <Text style={styles.link}>Open in Maps</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    gap: 6,
    marginTop: 8,
  },
  link: {
    color: '#2563eb',
    fontSize: 14,
  },
  map: {
    borderRadius: 10,
    height: 160,
    overflow: 'hidden',
  },
  placeholder: {
    alignItems: 'center',
    backgroundColor: '#f5f5f5',
    justifyContent: 'center',
    marginTop: 8,
  },
  placeholderLabel: {
    color: '#a3a3a3',
    fontSize: 13,
  },
});
