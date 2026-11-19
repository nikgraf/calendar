import { expect, it } from '@effect/vitest';
import { Schema } from 'effect';
import { Temporal } from '../time/temporal.ts';
import { EventRecord } from '../types.ts';
import { MIRROR_PRESETS, type MirrorDefinition } from './definition.ts';
import { type MirrorActual, planMirror } from './diff.ts';
import { googleEventMirrorItem, type MirrorItem } from './item.ts';
import { mirrorContentHash, mirrorKeyHash, mirrorTag } from './marker.ts';
import { buildMirrorCopies, type MirrorCopy } from './transform.ts';
import type { MirrorWindow } from './window.ts';

const START = Date.parse('2026-03-01T00:00:00Z');
const DAY = 86_400_000;
const Text = Schema.String.check(Schema.isMaxLength(40));
const Int = Schema.Int.check(Schema.isBetween({ maximum: 17_280, minimum: 0 }));
const Entry = Schema.Struct({
  allDay: Schema.Boolean,
  description: Text,
  done: Schema.Boolean,
  length: Schema.Int.check(Schema.isBetween({ maximum: 360, minimum: 1 })),
  location: Text,
  private: Schema.Boolean,
  start: Int,
  title: Text,
});
const Entries = Schema.Array(Entry).check(Schema.isBetweenLength(1, 12));
type Entry = typeof Entry.Type;

const window: MirrorWindow = {
  endDate: '2026-04-01',
  endUtc: START + 31 * DAY,
  startDate: '2026-03-01',
  startUtc: START,
  today: '2026-03-08',
};
const definition: MirrorDefinition = {
  busyLabel: 'Busy',
  destination: { calendarId: 'shared', email: 'me@example.com', kind: 'google' },
  fields: MIRROR_PRESETS.full.fields,
  filters: { allDay: 'copy', declined: 'copy', free: 'copy', private: 'busy' },
  id: 'mirror-property',
  monthsAhead: 1,
  name: 'Shared availability',
  sources: [{ calendarId: 'private', email: 'me@example.com', kind: 'google' }],
  timeZone: 'UTC',
  updatedAt: 3,
};

const itemsOf = (entries: ReadonlyArray<Entry>): Array<MirrorItem> =>
  entries.map((entry, index) => {
    const day = Temporal.PlainDate.from('2026-03-01').add({ days: entry.start % 12 });
    return {
      ...entry,
      ...(entry.allDay
        ? {
            endDate: day.add({ days: 1 + (entry.length % 3) }).toString(),
            startDate: day.toString(),
          }
        : {}),
      declined: false,
      endUtc: START + (entry.start + entry.length) * 60_000,
      free: false,
      key: `source|calendar-${index % 3}|item-${index}`,
      link: `https://example.com/private-meeting-${index}`,
      startUtc: START + entry.start * 60_000,
    };
  });

it.prop(
  'Google visibility stays private until explicitly public or default, including old rows with no visibility',
  { secret: Text },
  ({ secret }) => {
    for (const visibility of [undefined, 'private', 'confidential', 'public', 'default'] as const) {
      const event = new EventRecord({
        accountId: 'private-account',
        calendarId: 'private-calendar',
        description: `Secret notes ${secret}`,
        endUtc: START + 3_600_000,
        etag: null,
        hangoutLink: 'https://meet.google.com/abc-defg-hij',
        id: 'private-event',
        isAllDay: false,
        location: `Secret room ${secret}`,
        startUtc: START,
        status: 'confirmed',
        syncedAt: 1,
        syncStatus: 'synced',
        title: `Secret title ${secret}`,
        updatedAt: 1,
        visibility,
      });
      const item = googleEventMirrorItem(event, 'me@example.com');
      const hidden = visibility !== 'public' && visibility !== 'default';
      expect(item.private).toBe(hidden);
      const copy = buildMirrorCopies(definition, [item], window)[0]!;
      expect(copy.title).toBe(hidden ? 'Busy' : event.title.trim());
      expect(copy.location).toBe(hidden ? undefined : event.location!.trim());
      if (hidden) {
        expect(copy.description).toBeUndefined();
      } else {
        expect(copy.description).toContain('Secret notes');
      }
    }
  },
  { arbitrary: { runs: 100 } },
);

it.prop(
  'private details cannot affect copies or hashes under any of the eight field policies',
  { entries: Entries },
  ({ entries }) => {
    const original = itemsOf(entries).map((item) => ({ ...item, private: true }));
    const changed = original.map((item) => ({
      ...item,
      attendees: ['another-person@example.com'],
      description: `Changed secret description: ${item.description}`,
      done: !item.done,
      link: 'https://example.com/a-different-private-link',
      location: `Changed secret location: ${item.location}`,
      title: `Changed secret title: ${item.title}`,
    }));
    for (let policy = 0; policy < 8; policy += 1) {
      const mirror = {
        ...definition,
        fields: {
          description: (policy & 1) !== 0,
          location: (policy & 2) !== 0,
          title: (policy & 4) !== 0,
        },
      };
      const copies = buildMirrorCopies(mirror, original, window);
      expect(copies.length).toBeGreaterThan(0);
      expect(buildMirrorCopies(mirror, changed, window)).toEqual(copies);
      for (const copy of copies) {
        expect(copy.title).toBe('Busy');
        expect(copy.description).toBeUndefined();
        expect(copy.location).toBeUndefined();
        expect(Object.keys(copy).sort()).toEqual([
          'allDay',
          'contentHash',
          'description',
          'endDate',
          'endUtc',
          'keyHash',
          'location',
          'startDate',
          'startUtc',
          'title',
        ]);
      }
      expect(
        buildMirrorCopies(
          { ...mirror, filters: { ...mirror.filters, private: 'skip' } },
          changed,
          window,
        ),
      ).toEqual([]);
    }
  },
  { arbitrary: { runs: 100 } },
);

// A minute/day occupancy oracle does not share the interval-merging algorithm.
const coverage = (
  items: ReadonlyArray<
    Pick<MirrorItem, 'allDay' | 'endDate' | 'endUtc' | 'startDate' | 'startUtc'>
  >,
) => {
  const timed = new Set<number>();
  const days = new Set<number>();
  for (const item of items) {
    const from = item.allDay ? Date.parse(`${item.startDate!}T00:00:00Z`) : item.startUtc;
    const to = item.allDay ? Date.parse(`${item.endDate!}T00:00:00Z`) : item.endUtc;
    const unit = item.allDay ? DAY : 60_000;
    for (let at = from; at < to; at += unit) {
      (item.allDay ? days : timed).add(at / unit);
    }
  }
  return { days: [...days].sort((a, b) => a - b), timed: [...timed].sort((a, b) => a - b) };
};

it.prop(
  'availability copies preserve exactly the occupied times and hide source order, identity and multiplicity',
  { entries: Entries },
  ({ entries }) => {
    const items = itemsOf(entries);
    const mirror = { ...definition, fields: MIRROR_PRESETS.availability.fields };
    const copies = buildMirrorCopies(mirror, items, window);
    expect(coverage(copies)).toEqual(coverage(items));
    const shuffled = [...items].reverse().map((item, index) => ({
      ...item,
      description: 'Different private notes',
      key: `another-account|another-calendar|${index}`,
      location: 'A different location',
      title: 'A different title',
    }));
    expect(buildMirrorCopies(mirror, [...shuffled, ...shuffled], window)).toEqual(copies);
    for (const allDay of [false, true]) {
      const intervals = copies.filter((copy) => copy.allDay === allDay);
      for (let index = 1; index < intervals.length; index += 1) {
        expect(intervals[index]!.startUtc).toBeGreaterThan(intervals[index - 1]!.endUtc);
      }
    }
  },
  { arbitrary: { runs: 100 } },
);

const actualOf = (
  copy: MirrorCopy,
  ref: string,
  rev = definition.updatedAt,
): MirrorActual<string> => ({
  ...copy,
  marker: { contentHash: copy.contentHash, rev, tag: mirrorTag(definition.id) },
  order: ref,
  ref,
});

it.prop(
  'interrupted reconciliation converges and never touches foreign or out-of-window copies',
  {
    entries: Entries,
    flags: Schema.Array(Int).check(Schema.isMaxLength(12)),
    progress: Int,
    revisionOnly: Schema.Boolean,
  },
  ({ entries, flags, progress, revisionOnly }) => {
    const desired = buildMirrorCopies(definition, itemsOf(entries), window);
    let serial = 0;
    let actual = desired.flatMap((copy, index) => {
      if (index === 0) {
        return [];
      }
      if (revisionOnly) {
        return [actualOf(copy, `original-${index}`, 1)];
      }
      const flag = flags[index] ?? 0;
      if ((flag & 1) === 0) {
        return [];
      }
      const row = actualOf(copy, `original-${index}`, 1);
      const shifted =
        (flag & 8) === 0
          ? row
          : {
              ...row,
              ...(row.allDay
                ? {
                    endDate: Temporal.PlainDate.from(row.endDate!).add({ days: 1 }).toString(),
                    startDate: Temporal.PlainDate.from(row.startDate!).add({ days: 1 }).toString(),
                  }
                : {}),
              endUtc: row.endUtc + (row.allDay ? DAY : 60_000),
              startUtc: row.startUtc + (row.allDay ? DAY : 60_000),
            };
      const changed =
        (flag & 2) === 0
          ? shifted
          : {
              ...shifted,
              marker: {
                ...row.marker,
                contentHash: mirrorContentHash(['stale', copy.contentHash]),
              },
            };
      return (flag & 4) === 0
        ? [changed]
        : [changed, { ...changed, order: `duplicate-${index}`, ref: `duplicate-${index}` }];
    });
    const seed = desired[0]!;
    const foreign = {
      ...actualOf(seed, 'foreign'),
      marker: { contentHash: seed.contentHash, rev: 9, tag: mirrorTag('another-mirror') },
    };
    const outside = {
      ...actualOf(seed, 'outside'),
      allDay: false,
      endUtc: window.endUtc + DAY,
      startUtc: window.endUtc,
    };
    const beforeWindow = {
      ...actualOf(seed, 'before-window'),
      allDay: false,
      endUtc: window.startUtc + 60_000,
      startUtc: window.startUtc - 60_000,
    };
    const outsideDay = {
      ...actualOf(seed, 'outside-day'),
      allDay: true,
      endDate: '2026-04-02',
      endUtc: window.endUtc + DAY - 3_600_000,
      startDate: window.endDate,
      // An EventKit midnight can fall inside the UTC window while its
      // floating date is outside. The date owns all-day membership.
      startUtc: window.endUtc - 3_600_000,
    };
    const unwantedKey = mirrorKeyHash(definition.id, 'left-the-window');
    const protectedRows = [
      foreign,
      outside,
      beforeWindow,
      outsideDay,
      {
        ...foreign,
        keyHash: mirrorKeyHash('another-mirror', 'foreign-source'),
        order: 'foreign-unwanted',
        ref: 'foreign-unwanted',
      },
      ...[outside, beforeWindow, outsideDay].map((row) => ({
        ...row,
        keyHash: unwantedKey,
        order: `${row.order}-unwanted`,
        ref: `${row.ref}-unwanted`,
      })),
    ];
    const protectedRefs = new Set(protectedRows.map((row) => row.ref));
    const orphan = {
      ...actualOf(seed, 'orphan'),
      keyHash: mirrorKeyHash(definition.id, 'no-longer-wanted'),
    };
    const stale = {
      ...actualOf(seed, 'forced-a', 1),
      marker: {
        contentHash: revisionOnly
          ? seed.contentHash
          : mirrorContentHash(['stale', seed.contentHash]),
        rev: 1,
        tag: mirrorTag(definition.id),
      },
    };
    // Every evaluation exercises duplicate cleanup and removal. Revision-only
    // cases need a carrier update even though all desired content is current.
    actual.push(stale, { ...stale, order: 'forced-b', ref: 'forced-b' }, ...protectedRows, orphan);
    const plan = () =>
      planMirror({
        actual,
        desired,
        nowMs: START + 7 * DAY,
        rev: definition.updatedAt,
        tag: mirrorTag(definition.id),
        window,
      });
    // Every pass may stop after any positive prefix of writes. Replanning
    // from the destination is the recovery path after a lost response.
    const limit = actual.length + desired.length + 3;
    for (let pass = 0; pass < limit; pass += 1) {
      const next = plan();
      expect(next.foreign).toBe(2);
      if (next.ops.length === 0) {
        break;
      }
      const take = 1 + (progress % next.ops.length);
      for (const op of next.ops.slice(0, take)) {
        if (op.kind === 'create') {
          actual.push(actualOf(op.copy, `created-${serial++}`));
        } else {
          expect(protectedRefs.has(op.actual.ref)).toBe(false);
          actual = actual.filter((row) => row.ref !== op.actual.ref);
          if (op.kind === 'update') {
            actual.push(actualOf(op.copy, op.actual.ref));
          }
        }
      }
      for (const protectedRow of protectedRows) {
        expect(actual.find((row) => row.ref === protectedRow.ref)).toEqual(protectedRow);
      }
    }
    expect(plan().ops).toEqual([]);
    const managed = actual.filter((row) => !protectedRefs.has(row.ref));
    expect(managed.some((row) => row.marker.rev === definition.updatedAt)).toBe(true);
    expect(managed.map((row) => row.keyHash).sort()).toEqual(
      desired.map((copy) => copy.keyHash).sort(),
    );
    for (const row of managed) {
      const copy = desired.find((entry) => entry.keyHash === row.keyHash)!;
      expect(row).toMatchObject({
        allDay: copy.allDay,
        endDate: copy.endDate,
        endUtc: copy.endUtc,
        startDate: copy.startDate,
        startUtc: copy.startUtc,
      });
      expect(row.marker.contentHash).toBe(copy.contentHash);
    }
    expect(
      planMirror({
        actual: [...actual].reverse(),
        desired: [...desired].reverse(),
        nowMs: START,
        rev: definition.updatedAt,
        tag: mirrorTag(definition.id),
        window,
      }).ops,
    ).toEqual([]);
  },
  { arbitrary: { runs: 100 } },
);
