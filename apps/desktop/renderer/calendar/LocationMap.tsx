import { type EventPlace, useMapSnapshot } from '@calendar/app-state';
import { isMappableLocation } from '@calendar/core';
import { useColorScheme } from '../theme.ts';

/** Points; the editor panel is 420 wide with 24 of padding per side. */
const MAP_WIDTH = 372;
const MAP_HEIGHT = 160;

/**
 * A static Apple Maps image of the event's place (MKMapSnapshotter in the
 * Swift helper, requested at the display's pixel density) in the window's
 * appearance. Clicking it, or the link, opens the Maps app. Without a
 * helper (or offline) it falls back to the link; text MapKit cannot place
 * shows nothing but a quiet note.
 */
export function LocationMap({ place }: { place: EventPlace }) {
  const { location, mapGeo, mapLoading, mapsUrl } = place;
  const appearance = useColorScheme();
  const snapshot = useMapSnapshot(
    mapGeo
      ? {
          appearance,
          height: MAP_HEIGHT,
          lat: mapGeo.lat,
          lng: mapGeo.lng,
          scale: Math.min(Math.max(Math.round(window.devicePixelRatio || 1), 1), 3),
          width: MAP_WIDTH,
        }
      : null,
  );

  if (!isMappableLocation(location)) {
    return null;
  }
  if (!mapGeo || !mapsUrl) {
    return mapLoading ? (
      <div
        className="flex h-40 items-center justify-center rounded-lg bg-fill text-xs text-ink-secondary"
        data-map-state="loading"
      >
        Locating…
      </div>
    ) : null;
  }
  const open = () => window.open(mapsUrl, '_blank', 'noopener');
  return (
    <div className="flex flex-col gap-1">
      {snapshot.pngBase64 ? (
        <button
          aria-label={`Open ${mapGeo.name ?? location} in Maps`}
          className="overflow-hidden rounded-lg border border-hairline"
          onClick={open}
          type="button"
        >
          <img
            alt={`Map of ${mapGeo.name ?? location}`}
            className="block h-40 w-full object-cover"
            data-map
            src={`data:image/png;base64,${snapshot.pngBase64}`}
          />
        </button>
      ) : snapshot.loading ? (
        <div className="h-40 animate-pulse rounded-lg bg-fill" data-map-state="loading" />
      ) : null}
      <a
        className="self-start text-xs text-primary hover:underline"
        data-open-in-maps
        href={mapsUrl}
        onClick={(clickEvent) => {
          clickEvent.preventDefault();
          open();
        }}
      >
        Open in Maps
      </a>
    </div>
  );
}
