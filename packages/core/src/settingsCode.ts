import { Effect, Schema } from 'effect';
import { deflateSync, inflateSync, strFromU8, strToU8, zlibSync } from 'fflate';
import { encodeQR } from 'qr';
import type { MirrorCalendarRef, MirrorDefinition, MirrorSourceRef } from './mirror/definition.ts';
import {
  parseSettingsDocument,
  type ParseSettingsOptions,
  type SettingsAccount,
  type SettingsDocument,
} from './settingsDocument.ts';
import { zoneCity } from './time/zones.ts';
import { isDeviceZone } from './timeZoneSettings.ts';

/**
 * The settings code: the settings document as one line of text a QR code
 * can carry, so a set-up device shows it and a new one reads it with its
 * camera or by paste. `SOLUNIVO:<version>:` + base32 (RFC 4648, no
 * padding) of the raw-deflated JSON. Base32's alphabet (A–Z, 2–7) sits
 * inside the QR alphanumeric set, which packs a character into 5.5 bits —
 * base64's lowercase letters would force byte mode, two to four versions
 * larger — and it has nothing a paste, a messenger or a URL mangles: no
 * space, no `%`, no `+`, so a reader may drop whitespace.
 *
 * What the import never reads is left out to keep the code small: Google
 * calendar and task-list titles (Google matches by id), Google titles in
 * mirror refs, and the Mac-only `desktop` section. Apple titles stay —
 * they are how an Apple calendar or Reminders list is matched.
 */
export const SETTINGS_CODE_VERSION = 1;
export const SETTINGS_CODE_PREFIX = 'SOLUNIVO';

/** The JSON a code may expand to; deflate's 1:1000 ratio makes a cap necessary. */
const MAX_INFLATED_BYTES = 256 * 1024;
/**
 * The longest payload worth decoding: that JSON deflated at its worst
 * (stored blocks, 5 bytes each per 64 KB, and a little slack), in base32's
 * 8 characters per 5 bytes. A code too large for a QR travels as text, so
 * every document the decoder would accept must fit — not just a QR's worth.
 */
export const MAX_CODE_LENGTH = Math.ceil(((MAX_INFLATED_BYTES + 1024) * 8) / 5);

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export class SettingsCodeError extends Schema.Error<SettingsCodeError>('core/SettingsCodeError')({
  message: Schema.String,
}) {}

/** The code does not fit one QR code; its text still copies. */
export class SettingsCodeTooLargeError extends Schema.Error<SettingsCodeTooLargeError>(
  'core/SettingsCodeTooLargeError',
)({ length: Schema.Number }) {}

/** RFC 4648 base32 without `=` padding. */
export const base32Encode = (bytes: Uint8Array): string => {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(buffer >> bits) & 31];
    }
    buffer &= (1 << bits) - 1;
  }
  if (bits > 0) {
    out += BASE32[(buffer << (5 - bits)) & 31];
  }
  return out;
};

/** The inverse; `=` padding is accepted and ignored. Null on a character outside the alphabet. */
export const base32Decode = (text: string): Uint8Array | null => {
  const clean = text.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((clean.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of clean) {
    const value = BASE32.indexOf(char);
    if (value < 0) {
      return null;
    }
    buffer = (buffer << 5) | value;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 255;
    }
    buffer &= (1 << bits) - 1;
  }
  return out;
};

const PREFIX_PATTERN = new RegExp(`${SETTINGS_CODE_PREFIX}:(\\d+):`, 'gi');
const PAYLOAD_CHAR = /[A-Z2-7]/;
const SPACE = /\s/;
/** Shorter than any document deflates to: "Solunivo:2:Design…" in a note is no code. */
const MIN_PAYLOAD_LENGTH = 16;

/**
 * The code inside a paste, a share or a URL, in its one spelling; null
 * when there is none. The prefix must stand as written (any case — a URL's
 * scheme may arrive lowercased — but no spaces in it), so a note that
 * merely starts "Solunivo: 2: …" stays a note for the AI. After it,
 * whitespace goes (a mail client may wrap a long line, and the alphabet
 * has no space); the payload is upper case, ends at the first character
 * outside the alphabet, and is long enough to hold a document.
 */
export const extractSettingsCode = (text: string): string | null => {
  for (const prefix of text.matchAll(PREFIX_PATTERN)) {
    // Walk this payload only — up to the first character that is neither
    // in the alphabet nor a space — so many failed prefixes cost a line
    // each, never the rest of the text each.
    const start = prefix.index + prefix[0].length;
    let end = start;
    while (
      end < text.length &&
      (PAYLOAD_CHAR.test(text.charAt(end)) || SPACE.test(text.charAt(end)))
    ) {
      end++;
    }
    const payload = text.slice(start, end).replaceAll(/\s+/g, '');
    if (payload.length >= MIN_PAYLOAD_LENGTH) {
      return `${SETTINGS_CODE_PREFIX}:${prefix[1]}:${payload}`;
    }
  }
  return null;
};

export const isSettingsCode = (text: string): boolean => extractSettingsCode(text) !== null;

/** A Google ref without its title, which is for readability only (matched by email and id). */
const stripCalendarRef = (ref: MirrorCalendarRef): MirrorCalendarRef => {
  if (ref.kind !== 'google') {
    return ref;
  }
  const { title: _title, ...rest } = ref;
  return rest;
};

const stripSourceRef = (ref: MirrorSourceRef): MirrorSourceRef => {
  if (ref.kind === 'googleTasks') {
    const { title: _title, ...rest } = ref;
    return rest;
  }
  return ref.kind === 'google' || ref.kind === 'apple' ? stripCalendarRef(ref) : ref;
};

const stripMirror = (mirror: MirrorDefinition): MirrorDefinition => ({
  ...mirror,
  destination: stripCalendarRef(mirror.destination),
  sources: mirror.sources.map(stripSourceRef),
});

const stripAccount = (account: SettingsAccount): SettingsAccount =>
  account.kind === 'google'
    ? {
        ...account,
        ...(account.calendars
          ? { calendars: account.calendars.map((pref) => ({ ...pref, title: '' })) }
          : {}),
        ...(account.taskLists
          ? { taskLists: account.taskLists.map((pref) => ({ ...pref, title: '' })) }
          : {}),
      }
    : account;

/** The document as the code carries it: what the import never reads, left out. */
export const settingsCodeDocument = (document: SettingsDocument): SettingsDocument => {
  const { desktop: _desktop, ...rest } = document;
  return {
    ...rest,
    ...(document.accounts ? { accounts: document.accounts.map(stripAccount) } : {}),
    ...(document.mirrors ? { mirrors: document.mirrors.map(stripMirror) } : {}),
  };
};

/** The document → the code's text. Never fails: a code too large for a QR still copies as text. */
export const encodeSettingsCode = (document: SettingsDocument): string => {
  const json = JSON.stringify(settingsCodeDocument(document));
  const packed = deflateSync(strToU8(json), { level: 9 });
  return `${SETTINGS_CODE_PREFIX}:${SETTINGS_CODE_VERSION}:${base32Encode(packed)}`;
};

const fail = (message: string) => Effect.fail(new SettingsCodeError({ message }));

/**
 * Text that holds a code → the document it carries, through the same
 * parse (and zone normalization) a settings file goes through. Each step
 * names what went wrong; a code from a newer app says so.
 */
export const decodeSettingsCode = (
  text: string,
  options: ParseSettingsOptions = {},
): Effect.Effect<SettingsDocument, SettingsCodeError> =>
  Effect.gen(function* () {
    if (text.length > MAX_CODE_LENGTH * 2) {
      return yield* fail('That is too long to be a Solunivo code.');
    }
    const code = extractSettingsCode(text);
    if (code === null) {
      return yield* fail('That isn’t a Solunivo code.');
    }
    const [, version = '', payload = ''] = code.split(':');
    if (Number(version) > SETTINGS_CODE_VERSION) {
      return yield* fail('This code was made by a newer Solunivo. Update this app to read it.');
    }
    if (Number(version) !== SETTINGS_CODE_VERSION) {
      return yield* fail(`Unsupported code version ${version}.`);
    }
    if (payload.length > MAX_CODE_LENGTH) {
      return yield* fail('That is too long to be a Solunivo code.');
    }
    const packed = base32Decode(payload);
    if (packed === null || packed.length === 0) {
      return yield* fail('The code is damaged: it has characters a code never has.');
    }
    const out = new Uint8Array(MAX_INFLATED_BYTES + 1);
    const inflated = yield* Effect.try({
      catch: () =>
        new SettingsCodeError({ message: 'The code is damaged or incomplete; read it again.' }),
      try: () => inflateSync(packed, { out }),
    });
    if (inflated.length > MAX_INFLATED_BYTES) {
      return yield* fail('The code expands to more than a settings document can be.');
    }
    return yield* parseSettingsDocument(strFromU8(inflated), options).pipe(
      Effect.mapError((error) => new SettingsCodeError({ message: error.message })),
    );
  });

/** A QR code's modules, quiet zone included: `modules[row][column]`, true = dark. */
export interface SettingsQr {
  readonly modules: ReadonlyArray<ReadonlyArray<boolean>>;
  readonly size: number;
  readonly version: number;
}

/** The four-module quiet zone a camera needs around the code. */
const QUIET_ZONE = 4;

/** The code → a QR at error correction M; a code past version 40 fails. */
export const settingsCodeQr = (
  code: string,
): Effect.Effect<SettingsQr, SettingsCodeTooLargeError> =>
  Effect.try({
    catch: () => new SettingsCodeTooLargeError({ length: code.length }),
    try: () => {
      const modules = encodeQR(code, 'raw', { border: QUIET_ZONE, ecc: 'medium' });
      // A version-v symbol is 17 + 4v modules a side, before the quiet zone.
      return { modules, size: modules.length, version: (modules.length - 17 - 2 * QUIET_ZONE) / 4 };
    },
  });

/** The dark modules as one SVG path in module units (`viewBox="0 0 size size"`), one rectangle per run. */
export const qrPathData = (qr: SettingsQr): string => {
  let path = '';
  qr.modules.forEach((row, y) => {
    let x = 0;
    while (x < qr.size) {
      if (!row[x]) {
        x++;
        continue;
      }
      const start = x;
      while (x < qr.size && row[x]) {
        x++;
      }
      path += `M${start} ${y}h${x - start}v1h${start - x}z`;
    }
  });
  return path;
};

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xff_ff_ff_ff;
  for (const byte of bytes) {
    crc = CRC_TABLE[(crc ^ byte) & 255]! ^ (crc >>> 8);
  }
  return (crc ^ 0xff_ff_ff_ff) >>> 0;
};

const chunk = (type: string, data: Uint8Array): Uint8Array => {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) {
    out[4 + i] = type.charCodeAt(i);
  }
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  const step = 0x80_00;
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step));
  }
  return btoa(binary);
};

/**
 * The QR as a 1-bit grayscale PNG data URI, `scale` pixels a module, for
 * an `Image` drawn at exactly that many device pixels — crisp without an
 * SVG renderer.
 */
export const qrPng = (qr: SettingsQr, scale: number): string => {
  const side = qr.size * scale;
  const rowBytes = Math.ceil(side / 8);
  const raw = new Uint8Array((rowBytes + 1) * side);
  for (let y = 0; y < side; y++) {
    const row = qr.modules[Math.floor(y / scale)]!;
    const offset = y * (rowBytes + 1);
    // Filter byte 0 (none) leads each scanline; set bits are white.
    for (let x = 0; x < side; x++) {
      if (!row[Math.floor(x / scale)]) {
        raw[offset + 1 + (x >> 3)]! |= 0x80 >> (x & 7);
      }
    }
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, side);
  view.setUint32(4, side);
  header.set([1, 0, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', header),
    chunk('IDAT', zlibSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0)),
  ];
  const png = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) {
    png.set(part, at);
    at += part.length;
  }
  return `data:image/png;base64,${toBase64(png)}`;
};

const plural = (count: number, noun: string, nouns = `${noun}s`): string =>
  `${count} ${count === 1 ? noun : nouns}`;

/** What a code (or file) carries, as lines a person reads before showing it: counts, never names. */
export const describeSettingsDocument = (document: SettingsDocument): ReadonlyArray<string> => {
  const accounts = document.accounts ?? [];
  const google = accounts.filter((account) => account.kind === 'google');
  let calendars = 0;
  let lists = 0;
  for (const account of accounts) {
    calendars += 'calendars' in account ? (account.calendars?.length ?? 0) : 0;
    lists += 'taskLists' in account ? (account.taskLists?.length ?? 0) : 0;
  }
  const lines: Array<string> = [];
  if (google.length > 0) {
    lines.push(
      `${plural(google.length, 'Google account')} — as a sign-in list, no passwords or tokens`,
    );
  }
  if (calendars + lists > 0) {
    const parts = [
      calendars > 0 ? plural(calendars, 'calendar') : null,
      lists > 0 ? plural(lists, 'task list') : null,
    ].filter((part) => part !== null);
    lines.push(`${parts.join(' and ')}, shown or hidden as here`);
  }
  const zones = document.timeZones?.zones ?? [];
  if (zones.some((zone) => !isDeviceZone(zone))) {
    const names = zones.map((zone) => (isDeviceZone(zone) ? 'the local zone' : zoneCity(zone)));
    lines.push(`Time zones: ${names.join(' · ')}`);
  }
  const alerts = [
    document.eventNotifications?.enabled ? 'event alerts' : null,
    document.taskNotifications?.enabled ? 'task alerts' : null,
    document.birthdayReminders?.enabled ? 'birthday reminders' : null,
  ].filter((part) => part !== null);
  if (alerts.length > 0) {
    const [first = '', ...rest] = alerts;
    const lead = first.charAt(0).toUpperCase() + first.slice(1);
    const last = rest.at(-1);
    lines.push(
      last === undefined ? lead : `${[lead, ...rest.slice(0, -1)].join(', ')} and ${last}`,
    );
  }
  const overrides = document.birthdayReminderOverrides?.length ?? 0;
  if (overrides > 0) {
    lines.push(`Birthday notice for ${plural(overrides, 'person', 'people')}`);
  }
  const mirrors = document.mirrors?.length ?? 0;
  if (mirrors > 0) {
    lines.push(`${plural(mirrors, 'calendar mirror')} — arriving switched off`);
  }
  return lines;
};
