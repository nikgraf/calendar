import { usePlaceMap } from '@calendar/app-state';
import { formatDistance, type GeoPoint, type PlaceMapEdge, type PlaceMapPin } from '@calendar/core';
import { SymbolView } from 'expo-symbols';
import { Fragment, useState } from 'react';
import { Image, PixelRatio, Pressable, StyleSheet, Text, View } from 'react-native';
import { BOX_FONT_SCALE, type ThemeColors, useStyles, useTheme } from '../theme.ts';

/** A pin's tap target: the HIG's 44 points, its pin in the middle. */
const TARGET = 44;

/** The spots pins stand on legs from, each once, by a key of their own. */
const spotsOf = (
  pins: ReadonlyArray<PlaceMapPin>,
): ReadonlyArray<[string, { readonly x: number; readonly y: number }]> => {
  const spots = new Map<string, { readonly x: number; readonly y: number }>();
  for (const { spot } of pins) {
    if (spot) {
      spots.set(`spot-${String(spot.x)},${String(spot.y)}`, spot);
    }
  }
  return [...spots];
};

/** A leg from a place's spot up to its pin, drawn as a turned hairline. */
function Leg({ pin }: { readonly pin: PlaceMapPin }) {
  const styles = useStyles(makeStyles);
  if (pin.spot === undefined) {
    return null;
  }
  const dx = pin.x - pin.spot.x;
  const dy = pin.y - pin.spot.y;
  const length = Math.hypot(dx, dy);
  return (
    <View
      pointerEvents="none"
      style={[
        styles.leg,
        {
          left: (pin.x + pin.spot.x) / 2 - length / 2,
          top: (pin.y + pin.spot.y) / 2 - 0.75,
          transform: [{ rotate: `${String(Math.atan2(dy, dx))}rad` }],
          width: length,
        },
      ]}
    />
  );
}

/** A place off the map: a tag on its side, pointing its way, with how far it is. */
function EdgeTag({
  disabled,
  edge,
  name,
  number,
  onPress,
}: {
  readonly disabled: boolean;
  readonly edge: PlaceMapEdge;
  readonly name: string;
  readonly number: number;
  readonly onPress: (() => void) | undefined;
}) {
  const styles = useStyles(makeStyles);
  const { colors } = useTheme();
  const distance = formatDistance(edge.meters);
  const chevron = {
    bottom: 'chevron.down',
    left: 'chevron.left',
    right: 'chevron.right',
    top: 'chevron.up',
  } as const;
  const tag = (
    <Pressable
      accessibilityLabel={`Take ${name}, ${distance} away`}
      accessibilityRole="button"
      disabled={disabled || onPress === undefined}
      onPress={onPress}
      style={({ pressed }) => [styles.edgeTarget, pressed && styles.pressed]}
      testID={`draft-place-edge-${String(edge.index)}`}
    >
      <View style={styles.edgeTag}>
        {edge.side === 'right' ? null : (
          <SymbolView name={chevron[edge.side]} size={10} tintColor={colors.text} weight="bold" />
        )}
        <View style={[styles.badge, styles.edgeBadge]}>
          <Text maxFontSizeMultiplier={1} style={[styles.badgeLabel, styles.edgeBadgeLabel]}>
            {number}
          </Text>
        </View>
        <Text maxFontSizeMultiplier={BOX_FONT_SCALE} numberOfLines={1} style={styles.edgeLabel}>
          {distance}
        </Text>
        {edge.side === 'right' ? (
          <SymbolView name="chevron.right" size={10} tintColor={colors.text} weight="bold" />
        ) : null}
      </View>
    </Pressable>
  );
  // A side tag hangs off its edge; one on the top or bottom is centered on its place.
  const place =
    edge.side === 'left'
      ? { left: 0, top: edge.at - TARGET / 2 }
      : edge.side === 'right'
        ? { right: 0, top: edge.at - TARGET / 2 }
        : edge.side === 'top'
          ? { alignItems: 'center' as const, left: edge.at - 100, top: 0, width: 200 }
          : { alignItems: 'center' as const, bottom: 0, left: edge.at - 100, width: 200 };
  return (
    <View pointerEvents="box-none" style={[styles.edge, place]}>
      {tag}
    </View>
  );
}

/**
 * A small map of a few places (`usePlaceMap`): an Apple Maps image of
 * exactly the stretch the layout fits, the app's own pins over it where
 * the layout says. Numbered pins answer the Assistant's "which place?"
 * (a tap takes that place, as its row does); pins too near each other
 * stand on legs from their spot, and a place off the map is a tag on the
 * edge it lies beyond. Without `numbered`, one place's dot and its name:
 * the card's map, whose tap opens Maps. Nothing at all where the platform
 * draws no map; until the image is here, a quiet box of its size.
 */
export function PlaceMap({
  disabled = false,
  height,
  label,
  names,
  numbered,
  onExpand,
  onOpen,
  onPick,
  places,
  testID,
}: {
  readonly disabled?: boolean | undefined;
  readonly height: number;
  /** The one place's name, beside its dot. */
  readonly label?: string | undefined;
  /** Each place's name, for what a pin says to VoiceOver. */
  readonly names: ReadonlyArray<string>;
  readonly numbered: boolean;
  readonly onExpand?: (() => void) | undefined;
  readonly onOpen?: (() => void) | undefined;
  readonly onPick?: ((index: number) => void) | undefined;
  readonly places: ReadonlyArray<GeoPoint>;
  readonly testID: string;
}) {
  const styles = useStyles(makeStyles);
  const { colors, scheme } = useTheme();
  const [width, setWidth] = useState(0);
  const map = usePlaceMap(places, {
    appearance: scheme,
    height,
    scale: PixelRatio.get(),
    width,
  });
  const measured = (
    <View
      onLayout={(layoutEvent) => setWidth(Math.round(layoutEvent.nativeEvent.layout.width))}
      style={styles.measure}
    />
  );
  if (map.kind === 'none') {
    // Measured still: a card that grows wider gets its map.
    return width === 0 ? <View style={[styles.box, { height }]}>{measured}</View> : measured;
  }
  const { layout } = map;
  const pins = (
    <>
      {layout.pins.map((pin) => (
        <Leg key={`leg-${String(pin.index)}`} pin={pin} />
      ))}
      {spotsOf(layout.pins).map(([key, spot]) => (
        <View
          key={key}
          pointerEvents="none"
          style={[styles.spot, { left: spot.x - 4, top: spot.y - 4 }]}
        />
      ))}
      {layout.pins.map((pin) =>
        numbered ? (
          <Pressable
            accessibilityLabel={`Take ${names[pin.index] ?? ''}`}
            accessibilityRole="button"
            disabled={disabled || onPick === undefined}
            key={pin.index}
            onPress={() => onPick?.(pin.index)}
            style={({ pressed }) => [
              styles.target,
              { left: pin.x - TARGET / 2, top: pin.y - TARGET / 2 },
              pressed && styles.pressed,
            ]}
            testID={`draft-place-pin-${String(pin.index)}`}
          >
            <View style={[styles.badge, styles.pin]}>
              <Text maxFontSizeMultiplier={1} style={styles.badgeLabel}>
                {pin.index + 1}
              </Text>
            </View>
          </Pressable>
        ) : (
          <Fragment key={pin.index}>
            <View
              pointerEvents="none"
              style={[styles.target, { left: pin.x - TARGET / 2, top: pin.y - TARGET / 2 }]}
            >
              <View style={styles.dot} />
            </View>
            {/* Beside the dot, as wide as the map leaves it. */}
            {label ? (
              <View
                pointerEvents="none"
                style={[
                  styles.name,
                  { left: pin.x + 14, maxWidth: Math.max(width - pin.x - 22, 60), top: pin.y - 11 },
                ]}
              >
                <Text maxFontSizeMultiplier={1.2} numberOfLines={1} style={styles.nameLabel}>
                  {label}
                </Text>
              </View>
            ) : null}
          </Fragment>
        ),
      )}
      {layout.edges.map((edge) => (
        <EdgeTag
          disabled={disabled}
          edge={edge}
          key={edge.index}
          name={names[edge.index] ?? ''}
          number={edge.index + 1}
          onPress={onPick ? () => onPick(edge.index) : undefined}
        />
      ))}
    </>
  );
  const box = (
    <View style={[styles.box, { height }]} testID={testID}>
      {map.kind === 'ready' ? (
        <>
          <Image
            accessibilityIgnoresInvertColors
            source={{ uri: `data:image/png;base64,${map.image}` }}
            style={StyleSheet.absoluteFill}
          />
          {pins}
        </>
      ) : null}
      {onExpand && map.kind === 'ready' ? (
        <Pressable
          accessibilityLabel="Show the map full height"
          accessibilityRole="button"
          onPress={onExpand}
          style={styles.expand}
          testID={`${testID}-expand`}
        >
          <View style={styles.expandFace}>
            <SymbolView
              name="arrow.up.left.and.arrow.down.right"
              size={13}
              tintColor={colors.text}
              weight="semibold"
            />
          </View>
        </Pressable>
      ) : null}
    </View>
  );
  return (
    <View>
      {measured}
      {onOpen ? (
        <Pressable
          accessibilityLabel={`Open ${label ?? ''} in Maps`}
          accessibilityRole="button"
          onPress={onOpen}
        >
          {box}
        </Pressable>
      ) : (
        box
      )}
    </View>
  );
}

const makeStyles = (colors: ThemeColors) =>
  StyleSheet.create({
    badge: {
      alignItems: 'center',
      backgroundColor: colors.primary,
      borderRadius: 12,
      height: 24,
      justifyContent: 'center',
      width: 24,
    },
    badgeLabel: {
      color: colors['on-primary'],
      fontSize: 13,
      fontVariant: ['tabular-nums'],
      fontWeight: '700',
    },
    box: {
      backgroundColor: colors.fill,
      borderColor: colors.border,
      borderRadius: 14,
      borderWidth: StyleSheet.hairlineWidth,
      overflow: 'hidden',
    },
    /** The card's one place: a dot ringed in the surface, so it reads on any map. */
    dot: {
      backgroundColor: colors.primary,
      borderColor: colors.surface,
      borderRadius: 8,
      borderWidth: 3,
      height: 16,
      width: 16,
    },
    edge: {
      position: 'absolute',
    },
    edgeBadge: {
      borderRadius: 10,
      height: 20,
      width: 20,
    },
    edgeBadgeLabel: {
      fontSize: 12,
    },
    edgeLabel: {
      color: colors.text,
      fontSize: 13,
      fontWeight: '600',
    },
    edgeTag: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 15,
      flexDirection: 'row',
      gap: 6,
      height: 30,
      paddingHorizontal: 8,
      shadowColor: '#000000',
      shadowOffset: { height: 1, width: 0 },
      shadowOpacity: 0.18,
      shadowRadius: 3,
    },
    edgeTarget: {
      height: TARGET,
      justifyContent: 'center',
      paddingHorizontal: 6,
    },
    expand: {
      alignItems: 'center',
      height: TARGET,
      justifyContent: 'center',
      position: 'absolute',
      right: 0,
      top: 0,
      width: TARGET,
    },
    expandFace: {
      alignItems: 'center',
      backgroundColor: colors.surface,
      borderRadius: 15,
      height: 30,
      justifyContent: 'center',
      opacity: 0.94,
      shadowColor: '#000000',
      shadowOffset: { height: 1, width: 0 },
      shadowOpacity: 0.15,
      shadowRadius: 2,
      width: 30,
    },
    leg: {
      backgroundColor: colors.primary,
      height: 1.5,
      position: 'absolute',
    },
    measure: {
      height: 0,
    },
    name: {
      backgroundColor: colors.surface,
      borderRadius: 8,
      opacity: 0.94,
      paddingHorizontal: 7,
      paddingVertical: 3,
      position: 'absolute',
    },
    nameLabel: {
      color: colors.text,
      fontSize: 12,
      fontWeight: '600',
    },
    /** A numbered pin, ringed in the surface so it reads on any map. */
    pin: {
      borderColor: colors.surface,
      borderRadius: 14,
      borderWidth: 2,
      height: 28,
      width: 28,
    },
    pressed: {
      opacity: 0.7,
    },
    spot: {
      backgroundColor: colors.primary,
      borderColor: colors.surface,
      borderRadius: 4,
      borderWidth: 2,
      height: 8,
      position: 'absolute',
      width: 8,
    },
    target: {
      alignItems: 'center',
      height: TARGET,
      justifyContent: 'center',
      position: 'absolute',
      width: TARGET,
    },
  });
