import {
  CarriedText,
  EventRecord,
  type GeoLocation,
  type PendingOp,
  withConsistentGeo,
} from '@calendar/core';
import type { EventRepoShape } from '@calendar/db';
import { Effect } from 'effect';
import type { SqlError } from 'effect/unstable/sql/SqlError';

/**
 * Google copies a changed title, description or location of a series onto
 * every exception, overridden ones included, and leaves the exceptions'
 * value of a field whose value did not change (verified live 2026-09-24).
 * A series edit mirrors that at once instead of showing the old text until
 * the next pull. The mirror is a projection of the queued op: the op keeps
 * Google's text for the master and each exception's own text
 * (`CarriedText`), so an edit that coalesces into it is measured against
 * what Google has — an offline rename and its revert change nothing — and
 * abandoning it puts the exceptions' text back, with the coordinates a
 * carried location had to drop.
 */
const FIELDS = ['description', 'location', 'title'] as const;
type Field = (typeof FIELDS)[number];
type Text = { [F in Field]?: string | null };
type Entry = CarriedText['overrides'][number];

/** Google keeps no empty text: an empty field and a missing one are the same value. */
const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? '') === (b ?? '');

/**
 * Whether the exception still shows what `op` carried onto it: no pull or
 * push has replaced the row since (its etag is the one `entry` saw), and
 * no local edit changed the field. An op whose payload no longer decodes
 * cannot compare values and relies on the etag alone.
 */
const stillCarried = (row: EventRecord, op: PendingOp, entry: Entry, field: Field): boolean =>
  row.etag === entry.etag && (op.payload === undefined || same(row[field], op.payload[field]));

/** `row` with `text` written over it; `geo`, when given, goes with the location. */
const withText = (row: EventRecord, text: Text, geo?: GeoLocation | null): EventRecord =>
  FIELDS.every((field) => text[field] === undefined || text[field] === (row[field] ?? null))
    ? row
    : withConsistentGeo(
        new EventRecord({
          ...row,
          ...(text.description === undefined ? {} : { description: text.description ?? undefined }),
          ...(text.location === undefined ? {} : { location: text.location ?? undefined }),
          ...(typeof text.title === 'string' ? { title: text.title } : {}),
          ...(geo === undefined ? {} : { geo: geo ?? undefined }),
        }),
      );

/**
 * The exception rows a series edit rewrites and the `CarriedText` its op
 * keeps. `master` is the local row before this edit (it may already show
 * a queued edit), `queued` the series op this edit replaces.
 */
export const planCarry = ({
  master,
  merged,
  overrides,
  queued,
}: {
  readonly master: EventRecord;
  readonly merged: EventRecord;
  readonly overrides: ReadonlyArray<EventRecord>;
  readonly queued: PendingOp | undefined;
}): {
  readonly carriedText: CarriedText | undefined;
  readonly rows: ReadonlyArray<EventRecord>;
} => {
  const base = queued?.carriedText?.base ?? {
    description: master.description ?? null,
    location: master.location ?? null,
    title: master.title,
  };
  const changed = new Set(FIELDS.filter((field) => !same(merged[field], base[field])));
  const rows: Array<EventRecord> = [];
  const entries: Array<Entry> = [];
  for (const row of overrides) {
    if (row.status === 'cancelled') {
      continue;
    }
    const before = queued?.carriedText?.overrides.find((entry) => entry.eventId === row.id);
    const text: Text = {};
    const own: Text = {};
    let ownGeo: GeoLocation | null | undefined;
    let restoredGeo: GeoLocation | null | undefined;
    for (const field of FIELDS) {
      // What the queued op's carry replaced, while the row still shows that
      // carry; otherwise the row's value (pulled or edited since) is its own.
      const previous = before?.[field];
      const kept =
        previous !== undefined &&
        before !== undefined &&
        queued !== undefined &&
        stillCarried(row, queued, before, field);
      const ownValue = kept ? previous : (row[field] ?? null);
      const geo = kept ? (before.geo ?? null) : (row.geo ?? null);
      if (changed.has(field)) {
        text[field] = merged[field] ?? null;
        own[field] = ownValue;
        if (field === 'location') {
          ownGeo = geo;
        }
      } else {
        text[field] = ownValue;
        if (field === 'location' && kept) {
          restoredGeo = geo;
        }
      }
    }
    const next = withText(row, text, restoredGeo);
    if (next !== row) {
      rows.push(next);
    }
    if (changed.size > 0) {
      entries.push({
        etag: row.etag,
        eventId: row.id,
        ...own,
        ...(ownGeo === undefined ? {} : { geo: ownGeo }),
      } as Entry);
    }
  }
  return {
    carriedText: changed.size > 0 ? new CarriedText({ base, overrides: entries }) : undefined,
    rows,
  };
};

/**
 * Puts back the exceptions' own text when `op` is abandoned. A field the
 * user has edited on the exception since keeps the newer value, and a row
 * a pull or push has replaced since keeps Google's version.
 */
export const restoreCarriedText = (
  eventRepo: EventRepoShape,
  op: PendingOp,
): Effect.Effect<void, SqlError> =>
  Effect.gen(function* () {
    if (op.kind !== 'update' || !op.carriedText) {
      return;
    }
    const rows: Array<EventRecord> = [];
    for (const entry of op.carriedText.overrides) {
      const row = yield* eventRepo.getById(op.accountId, op.calendarId, entry.eventId);
      if (!row || row.status === 'cancelled') {
        continue;
      }
      const text: Text = {};
      for (const field of FIELDS) {
        const own = entry[field];
        if (own !== undefined && stillCarried(row, op, entry, field)) {
          text[field] = own;
        }
      }
      const restored = withText(row, text, text.location === undefined ? undefined : entry.geo);
      if (restored !== row) {
        rows.push(restored);
      }
    }
    if (rows.length > 0) {
      yield* eventRepo.upsertMany(rows);
    }
  });
