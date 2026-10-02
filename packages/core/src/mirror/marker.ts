import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils.js';

/**
 * How a mirror recognises its own copies, on any device, without a mapping
 * table: a copy's identity is a hash of the mirror's id and the source
 * item's portable key, and the copy carries a marker saying which mirror
 * wrote it, at which revision of its definition, and what it wrote.
 *
 * Everything here is opaque on purpose. A destination calendar is shared
 * with other people, and both carriers can be read by them (a Google
 * private extended property through the API, an Apple event's URL in any
 * calendar app): the key is salted with the mirror id, which never leaves
 * the user's devices, so a block cannot be matched to a known event, and
 * the content hash covers only what the copy itself shows.
 *
 * Synchronous and pure JS: Hermes has no `crypto.subtle`.
 */

/** Hex SHA-256 of a string. */
export const sha256Hex = (text: string): string => bytesToHex(sha256(utf8ToBytes(text)));

const KEY_HASH_LENGTH = 40;
const TAG_LENGTH = 12;
const CONTENT_HASH_LENGTH = 16;

/** A copy's identity inside its mirror: 40 hex characters. */
export const mirrorKeyHash = (mirrorId: string, sourceKey: string): string =>
  sha256Hex(`${mirrorId}|${sourceKey}`).slice(0, KEY_HASH_LENGTH);

/** Which mirror wrote a copy, without naming it: 12 hex characters. */
export const mirrorTag = (mirrorId: string): string =>
  sha256Hex(`tag|${mirrorId}`).slice(0, TAG_LENGTH);

/** 16 hex characters over the written fields, in a fixed order. */
export const mirrorContentHash = (parts: ReadonlyArray<string | number | boolean | null>): string =>
  sha256Hex(JSON.stringify(parts)).slice(0, CONTENT_HASH_LENGTH);

export interface MirrorMarker {
  readonly contentHash: string;
  /** The `updatedAt` of the definition that wrote the copy. */
  readonly rev: number;
  readonly tag: string;
}

const HEX = (length: number) => `[0-9a-f]{${length}}`;

// ---- Google: a derived event id plus a private extended property ----

/**
 * Google event ids are base32hex (a–v, 0–9); the prefix and a hex hash
 * both are. A second device inserting the same copy gets a 409 instead of
 * a duplicate.
 */
export const MIRROR_EVENT_ID_PREFIX = 'slnvmr';
export const MIRROR_PROPERTY_KEY = 'solunivo.mirror';

const EVENT_ID_RE = new RegExp(`^${MIRROR_EVENT_ID_PREFIX}(${HEX(KEY_HASH_LENGTH)})$`);
const PROPERTY_RE = new RegExp(
  `^(${HEX(TAG_LENGTH)})\\.(\\d{1,16})\\.(${HEX(CONTENT_HASH_LENGTH)})$`,
);

export const mirrorEventId = (keyHash: string): string => `${MIRROR_EVENT_ID_PREFIX}${keyHash}`;

export const keyHashOfMirrorEventId = (eventId: string): string | undefined =>
  EVENT_ID_RE.exec(eventId)?.[1];

export const encodeMirrorProperty = (marker: MirrorMarker): string =>
  `${marker.tag}.${marker.rev}.${marker.contentHash}`;

export const parseMirrorProperty = (value: string | null | undefined): MirrorMarker | undefined => {
  const match = PROPERTY_RE.exec(value ?? '');
  return match ? { contentHash: match[3]!, rev: Number(match[2]), tag: match[1]! } : undefined;
};

/**
 * The marker a Google event row keeps, or undefined when the event is not
 * a copy. Both halves must agree — the derived id and the property: an
 * event someone duplicated from a copy keeps the property but gets an id
 * of its own, and it is theirs, never hidden and never deleted.
 */
export const googleMirrorMarker = (
  eventId: string,
  property: string | null | undefined,
): string | undefined =>
  keyHashOfMirrorEventId(eventId) !== undefined && parseMirrorProperty(property) !== undefined
    ? (property ?? undefined)
    : undefined;

// ---- Apple: the event's URL (EventKit has no hidden field) ----

/** An opaque URI, deliberately not a scheme any app registers. */
export const MIRROR_URL_SCHEME = 'x-solunivo-mirror:';

const URL_RE = new RegExp(
  `^${MIRROR_URL_SCHEME}(${HEX(KEY_HASH_LENGTH)})\\.(${HEX(TAG_LENGTH)})\\.(\\d{1,16})\\.(${HEX(CONTENT_HASH_LENGTH)})$`,
);

export interface MirrorUrlMarker extends MirrorMarker {
  readonly keyHash: string;
}

export const encodeMirrorUrl = (marker: MirrorUrlMarker): string =>
  `${MIRROR_URL_SCHEME}${marker.keyHash}.${marker.tag}.${marker.rev}.${marker.contentHash}`;

export const parseMirrorUrl = (url: string | null | undefined): MirrorUrlMarker | undefined => {
  const match = URL_RE.exec(url ?? '');
  return match
    ? { contentHash: match[4]!, keyHash: match[1]!, rev: Number(match[3]), tag: match[2]! }
    : undefined;
};

export const isMirrorUrl = (url: string | null | undefined): boolean =>
  parseMirrorUrl(url) !== undefined;
