import type { ThemeScheme } from './tokens.ts';

/**
 * The three colors a calendar-colored item is drawn with: a soft fill, text
 * that reads on it, and a stronger edge for dots, swatches and legends.
 * Every calendar-colored block or chip in both apps goes through this; the
 * brand `event-*` tokens are for items with no calendar (birthdays, the
 * selection, task chips).
 */
export interface EventTint {
  readonly edge: string;
  readonly fill: string;
  readonly text: string;
}

type Rgb = readonly [number, number, number];

/** Google's blue, the same fallback `makeColorLookup` uses for an unknown calendar. */
const FALLBACK: Rgb = [0x42 / 255, 0x85 / 255, 0xf4 / 255];

// Lightness targets per scheme: the hue and chroma come from the calendar,
// the lightness from the theme, so a user's twenty-four Google colors land
// on one consistent row of tints. The text target is dark enough for 4.5:1
// on the fill for every hue (yellows are the tight case).
const TARGETS = {
  dark: { edge: 0.62, fill: 0.2, text: 0.84 },
  light: { edge: 0.52, fill: 0.9, text: 0.28 },
} as const;

const parseHex = (hex: string): Rgb | undefined => {
  const digits = hex.trim().replace(/^#/, '');
  if (!/^[\da-f]{6}$/i.test(digits)) {
    return undefined;
  }
  const value = Number.parseInt(digits, 16);
  return [((value >> 16) & 0xff) / 255, ((value >> 8) & 0xff) / 255, (value & 0xff) / 255];
};

const hueAndSaturation = ([red, green, blue]: Rgb): readonly [number, number] => {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const delta = max - min;
  if (delta === 0) {
    return [0, 0];
  }
  const lightness = (max + min) / 2;
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue =
    max === red
      ? ((green - blue) / delta + (green < blue ? 6 : 0)) * 60
      : max === green
        ? ((blue - red) / delta + 2) * 60
        : ((red - green) / delta + 4) * 60;
  return [hue, saturation];
};

const channel = (value: number): string =>
  Math.round(Math.min(1, Math.max(0, value)) * 255)
    .toString(16)
    .padStart(2, '0');

const hslToHex = (hue: number, saturation: number, lightness: number): string => {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const section = hue / 60;
  const x = chroma * (1 - Math.abs((section % 2) - 1));
  const [r1, g1, b1] =
    section < 1
      ? [chroma, x, 0]
      : section < 2
        ? [x, chroma, 0]
        : section < 3
          ? [0, chroma, x]
          : section < 4
            ? [0, x, chroma]
            : section < 5
              ? [x, 0, chroma]
              : [chroma, 0, x];
  const m = lightness - chroma / 2;
  return `#${channel(r1 + m)}${channel(g1 + m)}${channel(b1 + m)}`;
};

/**
 * Tints a calendar color for the given scheme. An unparsable color tints
 * like the fallback blue; a grey stays grey (its chroma is kept, not forced
 * up), any other color gets a chroma between 0.3 and 0.65 so pastel and
 * neon calendars sit on the same row.
 */
export const eventTint = (hex: string, scheme: ThemeScheme): EventTint => {
  const [hue, saturation] = hueAndSaturation(parseHex(hex) ?? FALLBACK);
  const chroma = saturation < 0.1 ? saturation : Math.min(0.65, Math.max(0.3, saturation));
  const targets = TARGETS[scheme];
  return {
    edge: hslToHex(hue, chroma, targets.edge),
    fill: hslToHex(hue, chroma, targets.fill),
    text: hslToHex(hue, chroma, targets.text),
  };
};
