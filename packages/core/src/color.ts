/**
 * Google Calendar's 24 standard calendar colors (colorIds 1-24), lowercase
 * hex — the write-back API accepts arbitrary RGB, but this palette matches
 * what Google's own UI offers.
 */
export const CALENDAR_PALETTE: ReadonlyArray<string> = [
  '#ac725e',
  '#d06b64',
  '#f83a22',
  '#fa573c',
  '#ff7537',
  '#ffad46',
  '#42d692',
  '#16a765',
  '#7bd148',
  '#b3dc6c',
  '#fbe983',
  '#fad165',
  '#92e1c0',
  '#9fe1e7',
  '#9fc6e7',
  '#4986e7',
  '#9a9cff',
  '#b99aff',
  '#c2c2c2',
  '#cabdbf',
  '#cca6ac',
  '#f691b2',
  '#cd74e6',
  '#a47ae2',
];

/** Black-ish or white text, whichever contrasts with the background. */
export const contrastingTextColor = (backgroundHex: string): string => {
  const hex = backgroundHex.replace('#', '');
  const red = Number.parseInt(hex.slice(0, 2), 16);
  const green = Number.parseInt(hex.slice(2, 4), 16);
  const blue = Number.parseInt(hex.slice(4, 6), 16);
  const luminance = 0.299 * red + 0.587 * green + 0.114 * blue;
  return luminance > 160 ? '#1f2937' : '#ffffff';
};

/** Lowercase #rrggbb or undefined when the input is not a full hex color. */
export const normalizeHexColor = (input: string): string | undefined => {
  const value = input.trim().toLowerCase();
  return /^#[0-9a-f]{6}$/.test(value) ? value : undefined;
};

/** `accountId:calendarId` — the key both apps use to look calendars up. */
export const calendarKey = (calendar: { accountId: string; id: string }): string =>
  `${calendar.accountId}:${calendar.id}`;

/** `calendarId:eventId` — stable across accounts, used for React keys. */
export const eventKey = (event: { calendarId: string; id: string }): string =>
  `${event.calendarId}:${event.id}`;

export type ColorLookup = (event: { accountId: string; calendarId: string }) => string;

/** Maps an event to its calendar's color, falling back to Google's blue. */
export const makeColorLookup = (
  calendars: ReadonlyArray<{ accountId: string; colorHex: string; id: string }>,
): ColorLookup => {
  const byKey = new Map(calendars.map((calendar) => [calendarKey(calendar), calendar.colorHex]));
  return (event) => byKey.get(`${event.accountId}:${event.calendarId}`) ?? '#4285f4';
};
