import { appendLink } from '../editor/convert.ts';
import { mergeBusy } from '../scheduling/busy.ts';
import { plainDateToUtcMs, utcMsToPlainDate } from '../time/convert.ts';
import { isAvailabilityMirror, type MirrorDefinition } from './definition.ts';
import type { MirrorItem } from './item.ts';
import { mirrorContentHash, mirrorKeyHash } from './marker.ts';
import { type MirrorWindow, startsInMirrorWindow } from './window.ts';

/**
 * One event a mirror wants in its destination — the whole of what gets
 * written. There is no "rest of the source event" to spread in: a field
 * that is not named here does not exist for a copy.
 */
export interface MirrorCopy {
  readonly allDay: boolean;
  /** Over the fields below; an unchanged hash means nothing to write. */
  readonly contentHash: string;
  readonly description: string | undefined;
  /** All-day end, exclusive. */
  readonly endDate: string | undefined;
  readonly endUtc: number;
  readonly keyHash: string;
  readonly location: string | undefined;
  readonly startDate: string | undefined;
  readonly startUtc: number;
  readonly title: string;
}

/** Google caps a description at 8192 characters; a title has no use for more than this. */
const MAX_DESCRIPTION = 8000;
const MAX_TITLE = 500;

/** Providers store instants to the second; comparing finer would never settle. */
const toSecond = (ms: number): number => Math.round(ms / 1000) * 1000;

const EVERYTHING = { endUtc: Number.MAX_SAFE_INTEGER, startUtc: Number.MIN_SAFE_INTEGER };

/** A location that is nothing but a link says how to join, not where. */
const placeOf = (location: string | undefined): string | undefined => {
  const text = location?.trim();
  return text === undefined || text === '' || /^https?:\/\/\S+$/i.test(text) ? undefined : text;
};

const finish = (
  definition: Pick<MirrorDefinition, 'timeZone'>,
  copy: Omit<MirrorCopy, 'contentHash'>,
): MirrorCopy => ({
  ...copy,
  contentHash: mirrorContentHash([
    copy.allDay,
    copy.allDay ? (copy.startDate ?? null) : copy.startUtc,
    copy.allDay ? (copy.endDate ?? null) : copy.endUtc,
    copy.title,
    copy.location ?? null,
    copy.description ?? null,
    // Copies are written in the mirror's zone; a changed zone rewrites them.
    definition.timeZone,
  ]),
});

/**
 * Busy blocks: overlapping items become one block, so neither how many
 * events there are nor which calendar they came from can be read back.
 * A block is keyed by its own start and end — it has no single source.
 */
const busyCopies = (
  definition: MirrorDefinition,
  items: ReadonlyArray<MirrorItem>,
): Array<MirrorCopy> => {
  const timed = mergeBusy(
    items
      .filter((item) => !item.allDay)
      .map((item) => ({ endUtc: toSecond(item.endUtc), startUtc: toSecond(item.startUtc) })),
    EVERYTHING,
  ).map((block) =>
    finish(definition, {
      allDay: false,
      description: undefined,
      endDate: undefined,
      endUtc: block.endUtc,
      keyHash: mirrorKeyHash(definition.id, `busy|${block.startUtc}|${block.endUtc}`),
      location: undefined,
      startDate: undefined,
      startUtc: block.startUtc,
      title: definition.busyLabel,
    }),
  );
  const days = mergeBusy(
    items.flatMap((item) =>
      item.allDay && item.startDate !== undefined && item.endDate !== undefined
        ? [{ endUtc: plainDateToUtcMs(item.endDate), startUtc: plainDateToUtcMs(item.startDate) }]
        : [],
    ),
    EVERYTHING,
  ).map((block) => {
    const startDate = utcMsToPlainDate(block.startUtc);
    const endDate = utcMsToPlainDate(block.endUtc);
    return finish(definition, {
      allDay: true,
      description: undefined,
      endDate,
      endUtc: block.endUtc,
      keyHash: mirrorKeyHash(definition.id, `busyday|${startDate}|${endDate}`),
      location: undefined,
      startDate,
      startUtc: block.startUtc,
      title: definition.busyLabel,
    });
  });
  return [...timed, ...days];
};

const itemCopy = (definition: MirrorDefinition, item: MirrorItem): MirrorCopy => {
  // A private event keeps its time and nothing else.
  const open = !item.private;
  const { fields } = definition;
  const title =
    fields.title && open && item.title.trim() !== ''
      ? `${item.done ? '✓ ' : ''}${item.title.trim()}`.slice(0, MAX_TITLE)
      : definition.busyLabel;
  const location = fields.location && open ? placeOf(item.location) : undefined;
  const description =
    fields.description && open
      ? appendLink(item.description?.trim() || undefined, item.link, location)?.slice(
          0,
          MAX_DESCRIPTION,
        )
      : undefined;
  // An all-day item is its dates; the instants only order it, and are
  // taken from the dates so every device orders alike (EventKit reports
  // an all-day event at this device's local midnight).
  const days = item.allDay && item.startDate !== undefined && item.endDate !== undefined;
  return finish(definition, {
    allDay: item.allDay,
    description,
    endDate: item.allDay ? item.endDate : undefined,
    endUtc: days ? plainDateToUtcMs(item.endDate) : toSecond(item.endUtc),
    keyHash: mirrorKeyHash(definition.id, item.key),
    location,
    startDate: item.allDay ? item.startDate : undefined,
    startUtc: days ? plainDateToUtcMs(item.startDate) : toSecond(item.startUtc),
    title,
  });
};

/**
 * The copies a mirror wants, from everything its sources hold. Items that
 * start outside the window or that a filter leaves out produce nothing;
 * the result is in start order and holds each identity once.
 */
export const buildMirrorCopies = (
  definition: MirrorDefinition,
  items: ReadonlyArray<MirrorItem>,
  window: MirrorWindow,
): ReadonlyArray<MirrorCopy> => {
  const { filters } = definition;
  const kept = items.filter(
    (item) =>
      startsInMirrorWindow(window, item) &&
      !(item.declined && filters.declined === 'skip') &&
      !(item.free && filters.free === 'skip') &&
      !(item.allDay && filters.allDay === 'skip') &&
      !(item.private && filters.private === 'skip'),
  );
  const copies = isAvailabilityMirror(definition.fields)
    ? busyCopies(definition, kept)
    : kept.map((item) => itemCopy(definition, item));
  const byKey = new Map<string, MirrorCopy>();
  for (const copy of copies) {
    if (!byKey.has(copy.keyHash)) {
      byKey.set(copy.keyHash, copy);
    }
  }
  return [...byKey.values()].sort(
    (a, b) => a.startUtc - b.startUtc || (a.keyHash < b.keyHash ? -1 : 1),
  );
};
