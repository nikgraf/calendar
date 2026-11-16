import { usePlaceMap } from '@calendar/app-state';
import { formatDistance, type GeoPoint, type PlaceMapEdge, type PlaceMapPin } from '@calendar/core';
import { type ReactNode, type RefObject, useEffect, useRef, useState } from 'react';
import { useColorScheme } from '../../theme.ts';
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronUpIcon,
  type IconProps,
} from '../../ui/icons.tsx';

const CHEVRONS: Record<PlaceMapEdge['side'], (props: IconProps) => ReactNode> = {
  bottom: ChevronDownIcon,
  left: ChevronLeftIcon,
  right: ChevronRightIcon,
  top: ChevronUpIcon,
};

/** The spots pins stand on legs from, each once, by a key of their own. */
const spotsOf = (
  pins: ReadonlyArray<PlaceMapPin>,
): ReadonlyArray<[string, { readonly x: number; readonly y: number }]> => {
  const spots = new Map<string, { readonly x: number; readonly y: number }>();
  for (const { spot } of pins) {
    if (spot) {
      spots.set(`${String(spot.x)},${String(spot.y)}`, spot);
    }
  }
  return [...spots];
};

/** The element's width in whole points, 0 until measured; it follows the panel's. */
const useWidth = (ref: RefObject<HTMLDivElement | null>): number => {
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const element = ref.current;
    if (!element) {
      return undefined;
    }
    const measure = () => setWidth(Math.round(element.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref]);
  return width;
};

/**
 * A place off the map: a tag on its side, pointing its way, with its
 * number — how far it is, its row says (and its label).
 */
function EdgeTag({
  disabled,
  edge,
  name,
  onPick,
}: {
  readonly disabled: boolean;
  readonly edge: PlaceMapEdge;
  readonly name: string;
  readonly onPick: ((index: number) => void) | undefined;
}) {
  const Chevron = CHEVRONS[edge.side];
  const distance = formatDistance(edge.meters);
  // A side tag hangs off its edge; one on the top or bottom is centered on its place.
  const place =
    edge.side === 'left'
      ? { left: 6, top: edge.at, transform: 'translateY(-50%)' }
      : edge.side === 'right'
        ? { right: 6, top: edge.at, transform: 'translateY(-50%)' }
        : edge.side === 'top'
          ? { left: edge.at, top: 6, transform: 'translateX(-50%)' }
          : { bottom: 6, left: edge.at, transform: 'translateX(-50%)' };
  return (
    <button
      aria-label={`Take ${name}, ${distance} away`}
      className={`absolute flex h-6 items-center gap-1.5 rounded-full bg-surface px-2 text-xs font-semibold text-ink shadow-sm ring-1 ring-hairline enabled:hover:bg-surface-subtle disabled:opacity-60 ${
        edge.side === 'right' ? 'flex-row-reverse' : ''
      }`}
      data-testid={`draft-place-edge-${String(edge.index)}`}
      disabled={disabled || onPick === undefined}
      onClick={() => onPick?.(edge.index)}
      style={place}
      title={`${name}, ${distance} away`}
      type="button"
    >
      <Chevron size={10} />
      <span className="flex size-4 items-center justify-center rounded-full bg-primary text-[10px] font-bold text-on-primary tabular-nums">
        {edge.index + 1}
      </span>
    </button>
  );
}

/**
 * A small map of a few places (`usePlaceMap`): an Apple Maps image of
 * exactly the stretch the layout fits, the app's own pins over it where
 * the layout says. Numbered pins answer the Assistant's "which place?"
 * (a click takes that place, as its row does; `lifted` raises the one
 * whose row the pointer is on — a pin under the pointer says so through
 * `onHover`, for its row to light up); pins too near each other
 * stand on legs from their spot, and a place off the map is a tag on the
 * edge it lies beyond. Without `numbered`, one place's dot and its name:
 * the card's map, whose click opens Maps. Nothing at all where no map
 * image comes; until it is here, a quiet box of its size.
 */
export function PlaceMap({
  disabled = false,
  height,
  label,
  lifted,
  names,
  numbered,
  onHover,
  onOpen,
  onPick,
  places,
  testId,
}: {
  readonly disabled?: boolean | undefined;
  readonly height: number;
  /** The one place's name, beside its dot. */
  readonly label?: string | undefined;
  /** The pin to raise: it or its row is under the pointer. */
  readonly lifted?: number | undefined;
  readonly names: ReadonlyArray<string>;
  readonly numbered: boolean;
  readonly onHover?: ((index: number | undefined) => void) | undefined;
  readonly onOpen?: (() => void) | undefined;
  readonly onPick?: ((index: number) => void) | undefined;
  readonly places: ReadonlyArray<GeoPoint>;
  readonly testId: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useWidth(ref);
  const appearance = useColorScheme();
  const map = usePlaceMap(places, {
    appearance,
    height,
    scale: window.devicePixelRatio || 1,
    width,
  });
  if (map.kind === 'none') {
    // Measured still: a panel that grows wider gets its map.
    return <div className="w-full" ref={ref} style={{ height: width === 0 ? height : 0 }} />;
  }
  const { layout } = map;
  // Tags first: where one cannot keep off a pin, the pin is on top and keeps its click.
  const pins = (
    <>
      {layout.edges.map((edge) => (
        <EdgeTag
          disabled={disabled}
          edge={edge}
          key={edge.index}
          name={names[edge.index] ?? ''}
          onPick={onPick}
        />
      ))}
      <svg
        aria-hidden
        className="pointer-events-none absolute inset-0 text-primary"
        height={height}
        width={width}
      >
        {layout.pins.map((pin) =>
          pin.spot ? (
            <line
              key={pin.index}
              stroke="currentColor"
              strokeLinecap="round"
              strokeWidth={1.5}
              x1={pin.spot.x}
              x2={pin.x}
              y1={pin.spot.y}
              y2={pin.y}
            />
          ) : null,
        )}
        {spotsOf(layout.pins).map(([key, spot]) => (
          <circle
            className="stroke-surface"
            cx={spot.x}
            cy={spot.y}
            fill="currentColor"
            key={key}
            r={4}
            strokeWidth={2}
          />
        ))}
      </svg>
      {layout.pins.map((pin) => {
        const raised = lifted === pin.index;
        const name = names[pin.index] ?? '';
        return numbered ? (
          <button
            aria-label={`Take ${name}`}
            className="group absolute flex size-8 -translate-x-1/2 -translate-y-1/2 items-center justify-center disabled:opacity-60"
            data-lifted={raised ? '' : undefined}
            data-testid={`draft-place-pin-${String(pin.index)}`}
            disabled={disabled || onPick === undefined}
            key={pin.index}
            onBlur={() => onHover?.(undefined)}
            onClick={() => onPick?.(pin.index)}
            onFocus={() => onHover?.(pin.index)}
            onMouseEnter={() => onHover?.(pin.index)}
            onMouseLeave={() => onHover?.(undefined)}
            style={{ left: pin.x, top: pin.y, zIndex: raised ? 2 : 1 }}
            title={name}
            type="button"
          >
            {/* Raised, not named: a name over the map would cover the pins around it. */}
            <span
              className={`flex size-6 items-center justify-center rounded-full bg-primary text-xs font-bold text-on-primary tabular-nums shadow-md ring-2 ring-surface transition-transform duration-150 ease-out motion-reduce:transition-none ${
                raised ? '-translate-y-1 scale-125 shadow-lg' : ''
              }`}
            >
              {pin.index + 1}
            </span>
          </button>
        ) : (
          <span
            className="pointer-events-none absolute flex -translate-x-1/2 -translate-y-1/2 items-center"
            key={pin.index}
            style={{ left: pin.x, top: pin.y }}
          >
            <span className="size-3.5 rounded-full bg-primary shadow-md ring-[3px] ring-surface" />
            {label ? (
              <span className="absolute left-full ml-2 max-w-44 truncate rounded-md bg-surface/95 px-1.5 py-0.5 text-xs font-semibold whitespace-nowrap text-ink shadow-sm">
                {label}
              </span>
            ) : null}
          </span>
        );
      })}
    </>
  );
  const image =
    map.kind === 'ready' ? (
      <img
        alt=""
        className="absolute inset-0 block size-full"
        draggable={false}
        src={`data:image/png;base64,${map.image}`}
      />
    ) : null;
  // The hairline is drawn over the image, not around it: the image fills
  // the measured box exactly, so a pin is where the layout put it.
  const frame = 'relative w-full overflow-hidden rounded-lg bg-fill';
  const edge = (
    <span className="pointer-events-none absolute inset-0 rounded-lg ring-1 ring-hairline ring-inset" />
  );
  return (
    <div className="w-full" ref={ref}>
      {onOpen ? (
        <button
          aria-label={`Open ${label ?? ''} in Maps`}
          className={`${frame} block text-left`}
          data-map-state={map.kind}
          data-testid={testId}
          onClick={onOpen}
          style={{ height }}
          type="button"
        >
          {image}
          {map.kind === 'ready' ? pins : null}
          {edge}
        </button>
      ) : (
        <div className={frame} data-map-state={map.kind} data-testid={testId} style={{ height }}>
          {image}
          {map.kind === 'ready' ? pins : null}
          {edge}
        </div>
      )}
    </div>
  );
}
