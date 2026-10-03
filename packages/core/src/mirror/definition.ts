import { Schema } from 'effect';
import { isValidTimeZone } from '../time/zones.ts';

/**
 * A calendar mirror: several sources (calendars, Google task lists,
 * Reminders lists) copied one way into one destination calendar, reduced
 * to the fields the definition allows. The app owns the copies and
 * overwrites them; nothing flows back.
 *
 * A definition is portable — it travels in the settings document so the
 * Mac and the iPhone run the same mirror — which is why it names calendars
 * the way that document does (Google by email + id, Apple by source and
 * title, Reminders lists by title) and carries its own time zone: "today"
 * and the window must come out the same on every device, or two devices
 * would undo each other's copies.
 */

/** How far ahead a new mirror copies, in months. */
export const MIRROR_DEFAULT_MONTHS = 3;
export const MIRROR_MAX_MONTHS = 24;
/** Copies older than this many days are left as they are. */
export const MIRROR_PAST_DAYS = 7;
export const MIRROR_DEFAULT_BUSY_LABEL = 'Busy';
export const MIRROR_MAX_SOURCES = 20;
const MAX_LABEL_LENGTH = 60;

export const MirrorGoogleCalendarRef = Schema.Struct({
  calendarId: Schema.String,
  email: Schema.String,
  kind: Schema.Literal('google'),
  /** For readability only; the calendar is matched by email and id. */
  title: Schema.optional(Schema.String),
});
export type MirrorGoogleCalendarRef = typeof MirrorGoogleCalendarRef.Type;

export const MirrorAppleCalendarRef = Schema.Struct({
  kind: Schema.Literal('apple'),
  /** EventKit source title: "iCloud", "On My Mac", a CalDAV account name. */
  source: Schema.String,
  title: Schema.String,
});
export type MirrorAppleCalendarRef = typeof MirrorAppleCalendarRef.Type;

export const MirrorCalendarRef = Schema.Union([MirrorGoogleCalendarRef, MirrorAppleCalendarRef]);
export type MirrorCalendarRef = typeof MirrorCalendarRef.Type;

export const MirrorGoogleTaskListRef = Schema.Struct({
  email: Schema.String,
  kind: Schema.Literal('googleTasks'),
  listId: Schema.String,
  /** For readability only; the list is matched by email and id. */
  title: Schema.optional(Schema.String),
});
export type MirrorGoogleTaskListRef = typeof MirrorGoogleTaskListRef.Type;

export const MirrorRemindersListRef = Schema.Struct({
  kind: Schema.Literal('reminders'),
  title: Schema.String,
});
export type MirrorRemindersListRef = typeof MirrorRemindersListRef.Type;

export const MirrorSourceRef = Schema.Union([
  MirrorGoogleCalendarRef,
  MirrorAppleCalendarRef,
  MirrorGoogleTaskListRef,
  MirrorRemindersListRef,
]);
export type MirrorSourceRef = typeof MirrorSourceRef.Type;

/**
 * The allow-list: a copy carries a field only when it is switched on here.
 * Guests, reminders, colour, attachments and the source's time zone are not
 * in the list and never reach a copy. All three off is the availability
 * mirror: merged busy blocks under the busy label.
 */
export const MirrorFields = Schema.Struct({
  description: Schema.Boolean,
  location: Schema.Boolean,
  title: Schema.Boolean,
});
export type MirrorFields = typeof MirrorFields.Type;

export const MirrorFilters = Schema.Struct({
  allDay: Schema.Literals(['copy', 'skip']),
  /** Events the user declined. */
  declined: Schema.Literals(['copy', 'skip']),
  /** Events marked free (Google's "transparent"); Apple events never say. */
  free: Schema.Literals(['copy', 'skip']),
  /** Private events: copied as the busy label with their time only, or left out. */
  private: Schema.Literals(['busy', 'skip']),
});
export type MirrorFilters = typeof MirrorFilters.Type;

export const MirrorDefinition = Schema.Struct({
  /** The title of busy blocks and of private events. */
  busyLabel: Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, MAX_LABEL_LENGTH))),
  destination: MirrorCalendarRef,
  fields: MirrorFields,
  filters: MirrorFilters,
  /** Stable across devices: copies are keyed by it. */
  id: Schema.String.pipe(Schema.check(Schema.isMinLength(1))),
  monthsAhead: Schema.Number.pipe(
    Schema.check(Schema.isInt(), Schema.isBetween({ maximum: MIRROR_MAX_MONTHS, minimum: 1 })),
  ),
  name: Schema.String.pipe(Schema.check(Schema.isBetweenLength(1, MAX_LABEL_LENGTH))),
  sources: Schema.Array(MirrorSourceRef).pipe(
    Schema.check(Schema.isBetweenLength(1, MIRROR_MAX_SOURCES)),
  ),
  /** The zone "today" and the window are computed in, and copies are written in. */
  timeZone: Schema.String.pipe(
    Schema.check(
      Schema.makeFilter((zone) =>
        isValidTimeZone(zone) ? undefined : `unknown time zone ${zone}`,
      ),
    ),
  ),
  /** Epoch ms of the last change to anything above; the revision copies are stamped with. */
  updatedAt: Schema.Number,
});
export type MirrorDefinition = typeof MirrorDefinition.Type;

export const MirrorDefinitions = Schema.Array(MirrorDefinition);

/** A ref as one string: equal refs give equal keys, on every device. */
export const mirrorRefKey = (ref: MirrorSourceRef): string => {
  switch (ref.kind) {
    case 'apple':
      return `apple|${ref.source}|${ref.title}`;
    case 'google':
      return `google|${ref.email.toLowerCase()}|${ref.calendarId}`;
    case 'googleTasks':
      return `googleTasks|${ref.email.toLowerCase()}|${ref.listId}`;
    case 'reminders':
      return `reminders|${ref.title}`;
  }
};

/** No field switched on: the mirror writes merged busy blocks. */
export const isAvailabilityMirror = (fields: MirrorFields): boolean =>
  !fields.title && !fields.location && !fields.description;

export type MirrorPreset = 'availability' | 'full' | 'titleLocation';

export const MIRROR_PRESETS: Record<
  MirrorPreset,
  { readonly fields: MirrorFields; readonly filters: MirrorFilters }
> = {
  availability: {
    fields: { description: false, location: false, title: false },
    filters: { allDay: 'skip', declined: 'skip', free: 'skip', private: 'busy' },
  },
  full: {
    fields: { description: true, location: true, title: true },
    filters: { allDay: 'copy', declined: 'skip', free: 'copy', private: 'busy' },
  },
  titleLocation: {
    fields: { description: false, location: true, title: true },
    filters: { allDay: 'copy', declined: 'skip', free: 'copy', private: 'busy' },
  },
};

export const MIRROR_PRESET_ORDER: ReadonlyArray<MirrorPreset> = [
  'availability',
  'titleLocation',
  'full',
];

const sameFlags = <T extends Record<string, unknown>>(a: T, b: T): boolean =>
  Object.keys(a).every((key) => a[key] === b[key]);

/** The preset a definition's fields and filters amount to, or 'custom'. */
export const mirrorPresetOf = (
  definition: Pick<MirrorDefinition, 'fields' | 'filters'>,
): MirrorPreset | 'custom' =>
  MIRROR_PRESET_ORDER.find(
    (preset) =>
      sameFlags(MIRROR_PRESETS[preset].fields, definition.fields) &&
      sameFlags(MIRROR_PRESETS[preset].filters, definition.filters),
  ) ?? 'custom';

export const withMirrorPreset = <T extends Pick<MirrorDefinition, 'fields' | 'filters'>>(
  definition: T,
  preset: MirrorPreset,
): T => ({ ...definition, ...MIRROR_PRESETS[preset] });

/**
 * A definition in its one spelling: trimmed text, sources in key order and
 * without repeats, the informational titles kept. Two definitions that
 * normalise to the same value (bar `updatedAt`) are the same mirror.
 */
export const normalizeMirror = (definition: MirrorDefinition): MirrorDefinition => {
  const sources = new Map<string, MirrorSourceRef>();
  for (const source of definition.sources) {
    sources.set(mirrorRefKey(source), source);
  }
  return {
    busyLabel: definition.busyLabel.trim() || MIRROR_DEFAULT_BUSY_LABEL,
    destination: definition.destination,
    fields: {
      description: definition.fields.description,
      location: definition.fields.location,
      title: definition.fields.title,
    },
    filters: {
      allDay: definition.filters.allDay,
      declined: definition.filters.declined,
      free: definition.filters.free,
      private: definition.filters.private,
    },
    id: definition.id,
    monthsAhead: Math.min(Math.max(Math.round(definition.monthsAhead), 1), MIRROR_MAX_MONTHS),
    name: definition.name.trim(),
    sources: [...sources.entries()]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([, source]) => source),
    timeZone: definition.timeZone,
    updatedAt: definition.updatedAt,
  };
};

/** What decides which copies exist and what they hold — everything but the name, the titles and the stamp. */
const mirrorSubstance = (definition: MirrorDefinition): string => {
  const normal = normalizeMirror(definition);
  return JSON.stringify([
    normal.busyLabel,
    mirrorRefKey(normal.destination),
    normal.fields,
    normal.filters,
    normal.monthsAhead,
    normal.sources.map(mirrorRefKey),
    normal.timeZone,
  ]);
};

/** Whether two definitions would write the same copies (the name and `updatedAt` do not count). */
export const sameMirrorSubstance = (a: MirrorDefinition, b: MirrorDefinition): boolean =>
  mirrorSubstance(a) === mirrorSubstance(b);

/**
 * Why a set of mirrors cannot be saved, or undefined when it can. Two
 * mirrors into one calendar would each treat the other's copies as
 * strangers; a destination that is also a source would feed a mirror its
 * own output.
 */
export const mirrorsIssue = (mirrors: ReadonlyArray<MirrorDefinition>): string | undefined => {
  const ids = new Set<string>();
  const destinations = new Map<string, string>();
  for (const mirror of mirrors) {
    if (ids.has(mirror.id)) {
      return `Two mirrors share the id ${mirror.id}.`;
    }
    ids.add(mirror.id);
    const key = mirrorRefKey(mirror.destination);
    const other = destinations.get(key);
    if (other !== undefined) {
      return `“${other}” and “${mirror.name}” copy into the same calendar. A calendar can be the destination of one mirror only.`;
    }
    destinations.set(key, mirror.name);
  }
  for (const mirror of mirrors) {
    const source = mirror.sources.find((ref) => destinations.has(mirrorRefKey(ref)));
    if (source !== undefined) {
      return `“${mirror.name}” reads from a calendar that “${destinations.get(mirrorRefKey(source))}” copies into. A destination cannot also be a source.`;
    }
  }
  return undefined;
};
