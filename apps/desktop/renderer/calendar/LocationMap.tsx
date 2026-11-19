import { type EventPlace, useMapSnapshot } from '@calendar/app-state';
import { isMappableLocation, locationDirectionsUrls } from '@calendar/core';
import { useColorScheme } from '../theme.ts';
import { Button } from '../ui/Button.tsx';
import { TEXT_ACTION_CLASS } from '../ui/buttonStyles.ts';
import { ArrowUpRightIcon } from '../ui/icons.tsx';

/** Points; the editor panel is 420 wide with 24 of padding per side. */
const MAP_WIDTH = 372;
const MAP_HEIGHT = 160;

/**
 * A static Apple Maps image of the event's place (MKMapSnapshotter in the
 * Swift helper, requested at the display's pixel density) in the window's
 * appearance. Clicking the map opens its place. Event details offer two
 * directions buttons, including before a lookup succeeds or offline;
 * the editor keeps its Open in Maps link.
 */
export function LocationMap({
  place,
  variant = 'editor',
}: {
  place: EventPlace;
  variant?: 'editor' | 'detail';
}) {
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
  if (variant === 'editor' && !mapGeo && !mapLoading) {
    return null;
  }
  const directions = variant === 'detail' ? locationDirectionsUrls(location, mapGeo) : undefined;
  const open = () => mapsUrl && window.open(mapsUrl, '_blank', 'noopener');
  return (
    <div className={`flex flex-col ${variant === 'detail' ? 'gap-3' : 'gap-1'}`}>
      {snapshot.pngBase64 && mapGeo ? (
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
      ) : mapLoading ? (
        <div
          className="flex h-40 items-center justify-center rounded-lg bg-fill text-xs text-ink-secondary"
          data-map-state="loading"
        >
          Locating…
        </div>
      ) : snapshot.loading ? (
        <div className="h-40 animate-pulse rounded-lg bg-fill" data-map-state="loading" />
      ) : null}
      {directions ? (
        <div aria-label="Get directions" className="flex flex-col gap-2" role="group">
          <p aria-hidden className="text-xs text-ink-secondary">
            Get directions
          </p>
          <div className="flex flex-wrap gap-2">
            {(
              [
                { id: 'apple', label: 'Apple Maps', url: directions.apple },
                { id: 'google', label: 'Google Maps', url: directions.google },
              ] as const
            ).map(({ id, label, url }) => (
              <Button
                aria-label={`Get directions in ${label}`}
                className="min-w-32 flex-1 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus active:scale-[0.97]"
                data-testid={`${id}-maps-directions`}
                key={id}
                onClick={() => window.open(url, '_blank', 'noopener')}
              >
                {label}
                <ArrowUpRightIcon className="shrink-0" size={13} />
              </Button>
            ))}
          </div>
        </div>
      ) : mapsUrl ? (
        <a
          className={`self-start text-xs ${TEXT_ACTION_CLASS.primary}`}
          data-open-in-maps
          href={mapsUrl}
          onClick={(clickEvent) => {
            clickEvent.preventDefault();
            open();
          }}
        >
          Open in Maps
        </a>
      ) : null}
    </div>
  );
}
