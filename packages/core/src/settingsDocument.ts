import { Effect, Schema } from 'effect';
// The package's `main` is a UMD build that requires its parts by relative
// path through the wrapper's own `require` argument — Metro and rolldown
// both bundle it without them ("Requiring unknown module ./impl/format"
// at launch). The ESM entry is plain and has its own .d.ts.
import {
  applyEdits,
  modify,
  parse,
  printParseErrorCode,
  type ParseError,
} from 'jsonc-parser/lib/esm/main.js';
import { BirthdayReminderSettings } from './birthdays/reminders.ts';
import { EventNotificationSettings } from './notifications/settings.ts';
import { canonicalZoneId, runtimeZoneId } from './time/zones.ts';
import { TimeZoneSettings } from './timeZoneSettings.ts';
import { ViewPreferences } from './viewPreferences.ts';

/**
 * The portable settings document: what Export writes, Import reads and the
 * desktop's watched `~/.solunivo/solunivo.jsonc` mirrors. Every section is
 * optional — an import applies the sections present and leaves the rest
 * alone — and nothing in it is secret: accounts are a sign-in checklist
 * (provider + email + per-calendar preferences), never tokens. Google
 * refresh tokens are bound to the OAuth client that issued them (desktop
 * and iOS use different clients), so a token could not even move between
 * platforms; on a new device each Google account is signed in once.
 *
 * Google calendar and task-list ids are stable across devices. Apple's
 * (EventKit identifiers) are not, so Apple calendars carry their source
 * and title and Reminders lists their title, matched best-effort.
 */
export const SETTINGS_DOCUMENT_VERSION = 1;

/** The source title an Apple calendar without one is filed under (matches the desktop sidebar). */
export const APPLE_DEFAULT_SOURCE = 'On My Mac';

export const ScreenPrivacy = Schema.Literals(['hidden', 'visible']);
export type ScreenPrivacy = typeof ScreenPrivacy.Type;

export const GoogleCalendarPref = Schema.Struct({
  id: Schema.String,
  /** For readability only; import matches by id. */
  title: Schema.String,
  visible: Schema.Boolean,
});
export type GoogleCalendarPref = typeof GoogleCalendarPref.Type;

export const GoogleTaskListPref = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  visible: Schema.Boolean,
});
export type GoogleTaskListPref = typeof GoogleTaskListPref.Type;

export const AppleCalendarPref = Schema.Struct({
  /** EventKit source title: "iCloud", "On My Mac", an Exchange account name. */
  source: Schema.String,
  title: Schema.String,
  visible: Schema.Boolean,
});
export type AppleCalendarPref = typeof AppleCalendarPref.Type;

export const AppleTaskListPref = Schema.Struct({
  title: Schema.String,
  visible: Schema.Boolean,
});
export type AppleTaskListPref = typeof AppleTaskListPref.Type;

export const GoogleSettingsAccount = Schema.Struct({
  calendars: Schema.optional(Schema.Array(GoogleCalendarPref)),
  email: Schema.String,
  kind: Schema.Literal('google'),
  taskLists: Schema.optional(Schema.Array(GoogleTaskListPref)),
});
export type GoogleSettingsAccount = typeof GoogleSettingsAccount.Type;

export const AppleCalendarSettingsAccount = Schema.Struct({
  calendars: Schema.optional(Schema.Array(AppleCalendarPref)),
  kind: Schema.Literal('apple-calendar'),
});
export type AppleCalendarSettingsAccount = typeof AppleCalendarSettingsAccount.Type;

export const AppleRemindersSettingsAccount = Schema.Struct({
  kind: Schema.Literal('apple-reminders'),
  taskLists: Schema.optional(Schema.Array(AppleTaskListPref)),
});
export type AppleRemindersSettingsAccount = typeof AppleRemindersSettingsAccount.Type;

export const SettingsAccount = Schema.Union([
  GoogleSettingsAccount,
  AppleCalendarSettingsAccount,
  AppleRemindersSettingsAccount,
]);
export type SettingsAccount = typeof SettingsAccount.Type;

/** The settings only the desktop app has; iOS ignores the section on import. */
export const DesktopSettings = Schema.Struct({
  screenPrivacy: Schema.optional(ScreenPrivacy),
});
export type DesktopSettings = typeof DesktopSettings.Type;

export const SettingsDocument = Schema.Struct({
  accounts: Schema.optional(Schema.Array(SettingsAccount)),
  birthdayReminders: Schema.optional(BirthdayReminderSettings),
  desktop: Schema.optional(DesktopSettings),
  eventNotifications: Schema.optional(EventNotificationSettings),
  timeZones: Schema.optional(TimeZoneSettings),
  version: Schema.Literal(SETTINGS_DOCUMENT_VERSION),
  view: Schema.optional(ViewPreferences),
});
export type SettingsDocument = typeof SettingsDocument.Type;

/** The top-level settings sections an import can change, for summaries. */
export const SettingsSection = Schema.Literals([
  'birthdayReminders',
  'eventNotifications',
  'screenPrivacy',
  'timeZones',
  'view',
]);
export type SettingsSection = typeof SettingsSection.Type;

export class SettingsParseError extends Schema.Error<SettingsParseError>('core/SettingsParseError')(
  {
    message: Schema.String,
  },
) {}

const decodeDocument = Schema.decodeUnknownEffect(SettingsDocument);

const describeParseError = (text: string, error: ParseError): string => {
  const before = text.slice(0, error.offset);
  const line = before.split('\n').length;
  const column = error.offset - before.lastIndexOf('\n');
  return `${printParseErrorCode(error.error)} at line ${line}, column ${column}`;
};

/**
 * Time zone ids as this engine spells them. Hermes' ICU rejects some modern
 * names (Asia/Kolkata) that the desktop writes, so a file from the other
 * platform is mapped through `runtimeZoneId` before the schema's validity
 * check sees it; an id neither spelling resolves stays as written and
 * fails decoding with a clear message.
 */
const normalizeZones = (
  raw: { primary?: unknown; zones?: unknown },
  isValidZone: ((id: string) => boolean) | undefined,
): { primary?: unknown; zones?: unknown } => {
  const map = (id: unknown): unknown =>
    typeof id === 'string' ? (runtimeZoneId(id, isValidZone) ?? id) : id;
  const zones = Array.isArray(raw.zones)
    ? [...new Set(raw.zones.map((zone) => map(zone)))]
    : raw.zones;
  return { ...raw, primary: map(raw.primary), zones };
};

export interface ParseSettingsOptions {
  /** Injectable for tests acting out an engine with a different zone table. */
  readonly isValidZone?: (id: string) => boolean;
}

/**
 * Text → document: tolerant JSONC (comments, trailing commas) → version
 * gate → zone normalization → schema decode. Each failure names what is
 * wrong; a file from a newer app says so instead of a literal mismatch.
 */
export const parseSettingsDocument = (
  text: string,
  options: ParseSettingsOptions = {},
): Effect.Effect<SettingsDocument, SettingsParseError> =>
  Effect.gen(function* () {
    const errors: Array<ParseError> = [];
    const raw: unknown = parse(text, errors, { allowTrailingComma: true });
    const first = errors[0];
    if (first) {
      return yield* new SettingsParseError({ message: describeParseError(text, first) });
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      return yield* new SettingsParseError({ message: 'The settings file must be a JSON object.' });
    }
    const record = raw as Record<string, unknown>;
    if (record['version'] !== SETTINGS_DOCUMENT_VERSION) {
      const version = record['version'];
      return yield* new SettingsParseError({
        message:
          typeof version === 'number' && version > SETTINGS_DOCUMENT_VERSION
            ? `This file was written by a newer Solunivo (version ${version}); update the app to import it.`
            : `Missing or unsupported "version" (expected ${SETTINGS_DOCUMENT_VERSION}).`,
      });
    }
    const timeZones = record['timeZones'];
    const normalized =
      typeof timeZones === 'object' && timeZones !== null && !Array.isArray(timeZones)
        ? { ...record, timeZones: normalizeZones(timeZones, options.isValidZone) }
        : record;
    return yield* decodeDocument(normalized).pipe(
      Effect.mapError((error) => new SettingsParseError({ message: error.message })),
    );
  });

/** The document with zones in their current IANA spelling, so a file written on either platform reads on the other. */
export const withCanonicalZones = (document: SettingsDocument): SettingsDocument =>
  document.timeZones
    ? {
        ...document,
        timeZones: {
          primary: canonicalZoneId(document.timeZones.primary),
          zones: [...new Set(document.timeZones.zones.map((zone) => canonicalZoneId(zone)))],
        },
      }
    : document;

/**
 * The document is plain data, so the wire form is the value itself. It is
 * deliberately not run through the schema on the way out: the zone filter
 * would re-validate a canonical spelling (Asia/Kolkata) in the exporting
 * runtime, and Hermes rejects some canonical names it wrote under their
 * legacy spelling — `parseSettingsDocument` maps them back on the way in.
 */
const encodeDocument = (document: SettingsDocument): Record<string, unknown> => ({ ...document });

export const SETTINGS_FILE_HEADER = [
  '// Solunivo settings. Edit freely; the app applies changes when the file is saved',
  '// and writes back when settings change in the app. Never contains tokens or',
  '// passwords: a Google account listed here shows up as "Sign in again".',
].join('\n');

export const SETTINGS_FORMATTING = { eol: '\n', insertSpaces: true, tabSize: 2 } as const;

/** The text Export writes and "Create file" seeds: a header comment plus 2-space JSON. */
export const formatSettingsDocument = (document: SettingsDocument): string =>
  `${SETTINGS_FILE_HEADER}\n${JSON.stringify(encodeDocument(document), null, 2)}\n`;

const SETTINGS_LEAF_PATHS: ReadonlyArray<readonly [keyof SettingsDocument, string]> = [
  ['birthdayReminders', 'enabled'],
  ['birthdayReminders', 'leadDays'],
  ['birthdayReminders', 'time'],
  ['desktop', 'screenPrivacy'],
  ['eventNotifications', 'enabled'],
  ['eventNotifications', 'includeAppleCalendar'],
  ['timeZones', 'primary'],
  ['timeZones', 'zones'],
  ['view', 'allDayLaneCollapsed'],
];

/**
 * Writes `document` into existing JSONC text, keeping comments, key order
 * and unknown keys: settings sections are edited leaf by leaf so a comment
 * beside one field survives a change to its neighbour; `accounts` is
 * replaced as a whole (comments inside it do not survive). Empty text
 * becomes a fresh formatted document. Idempotent: merging the document
 * the text already holds returns the text unchanged.
 */
export const mergeSettingsDocument = (text: string, document: SettingsDocument): string => {
  if (text.trim() === '') {
    return formatSettingsDocument(document);
  }
  const encoded = encodeDocument(document);
  const options = { formattingOptions: SETTINGS_FORMATTING };
  let result = text;
  const set = (path: ReadonlyArray<string>, value: unknown) => {
    result = applyEdits(result, modify(result, [...path], value, options));
  };
  set(['version'], encoded['version']);
  for (const [section, leaf] of SETTINGS_LEAF_PATHS) {
    const value = encoded[section];
    if (value === undefined) {
      continue;
    }
    const leafValue = (value as Record<string, unknown>)[leaf];
    if (leafValue !== undefined) {
      set([section, leaf], leafValue);
    }
  }
  if (encoded['accounts'] !== undefined) {
    set(['accounts'], encoded['accounts']);
  }
  return result;
};

/**
 * A local account id. Hermes lacks crypto.randomUUID, and the ids only
 * need to be unique within one device's database.
 */
export const generateLocalId = (): string =>
  // eslint-disable-next-line unicorn/prefer-crypto-uuid -- Hermes lacks crypto.randomUUID
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replaceAll(/[xy]/g, (char) => {
    const random = Math.trunc(Math.random() * 16);
    const value = char === 'x' ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });

/**
 * What an import would do (preview) or did (import): the same summary from
 * the same plan, so the confirmation never disagrees with the outcome.
 */
export const SettingsImportSummary = Schema.Struct({
  /** Apple accounts the file lists that are not connected here; their prefs wait for the connect. */
  appleAccountsPending: Schema.Array(
    Schema.Struct({
      kind: Schema.Literals(['apple-calendar', 'apple-reminders']),
      pendingCount: Schema.Number,
    }),
  ),
  /** Google emails the file lists that have no account here: created as "Sign in again". */
  googleAccountsToAdd: Schema.Array(Schema.String),
  /** Human-readable notes: ignored sections, unmatched entries kept pending. */
  notes: Schema.Array(Schema.String),
  settingsChanged: Schema.Array(SettingsSection),
  /** Calendar/list rows whose visibility changes now. */
  visibilityChanges: Schema.Number,
  /** Preferences parked until the matching calendar or list syncs. */
  visibilityPending: Schema.Number,
});
export type SettingsImportSummary = typeof SettingsImportSummary.Type;

const SECTION_LABELS: Record<SettingsSection, string> = {
  birthdayReminders: 'birthday reminders',
  eventNotifications: 'event notifications',
  screenPrivacy: 'screen privacy',
  timeZones: 'time zones',
  view: 'view preferences',
};

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** The summary as lines a person can read before confirming — the same words on both platforms. */
export const describeImportSummary = (summary: SettingsImportSummary): ReadonlyArray<string> => {
  const lines: Array<string> = [];
  if (summary.settingsChanged.length > 0) {
    lines.push(
      `Changes ${summary.settingsChanged.map((section) => SECTION_LABELS[section]).join(', ')}.`,
    );
  }
  for (const email of summary.googleAccountsToAdd) {
    lines.push(`Adds ${email} — it shows as "Sign in again" until you sign in.`);
  }
  for (const entry of summary.appleAccountsPending) {
    const what = entry.kind === 'apple-calendar' ? 'Apple Calendar' : 'Reminders';
    lines.push(
      `${what} is not connected here; ${plural(entry.pendingCount, 'preference')} wait for it.`,
    );
  }
  if (summary.visibilityChanges > 0) {
    lines.push(`Shows or hides ${plural(summary.visibilityChanges, 'calendar or list')}.`);
  }
  lines.push(...summary.notes);
  if (lines.length === 0) {
    lines.push('Nothing differs from this device.');
  }
  return lines;
};
