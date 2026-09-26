import { CarriedText, EventRecord, type PendingOp, withConsistentGeo } from '@calendar/core';
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
 * abandoning it puts the exceptions' text back.
 */
const FIELDS = ['description', 'location', 'title'] as const;
type Field = (typeof FIELDS)[number];
type Text = { [F in Field]?: string | null };

/** Google keeps no empty text: an empty field and a missing one are the same value. */
const same = (a: string | null | undefined, b: string | null | undefined): boolean =>
  (a ?? '') === (b ?? '');

/**
 * Whether the exception still shows what `op` carried onto it. An op whose
 * payload no longer decodes cannot tell, and counts as still carried.
 */
const stillCarried = (row: EventRecord, op: PendingOp, field: Field): boolean =>
  op.payload === undefined || same(row[field], op.payload[field]);

const withText = (row: EventRecord, text: Text): EventRecord =>
  FIELDS.every((field) => text[field] === undefined || text[field] === (row[field] ?? null))
    ? row
    : withConsistentGeo(
        new EventRecord({
          ...row,
          ...(text.description === undefined ? {} : { description: text.description ?? undefined }),
          ...(text.location === undefined ? {} : { location: text.location ?? undefined }),
          ...(typeof text.title === 'string' ? { title: text.title } : {}),
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
  const entries: Array<CarriedText['overrides'][number]> = [];
  for (const row of overrides) {
    if (row.status === 'cancelled') {
      continue;
    }
    const before = queued?.carriedText?.overrides.find((entry) => entry.eventId === row.id);
    const text: Text = {};
    const own: Text = {};
    for (const field of FIELDS) {
      // A later instance edit of the exception is its own text now.
      const previous = before?.[field];
      const ownValue =
        previous !== undefined && queued && stillCarried(row, queued, field)
          ? previous
          : (row[field] ?? null);
      if (changed.has(field)) {
        text[field] = merged[field] ?? null;
        own[field] = ownValue;
      } else {
        text[field] = ownValue;
      }
    }
    const next = withText(row, text);
    if (next !== row) {
      rows.push(next);
    }
    if (changed.size > 0) {
      entries.push({ eventId: row.id, ...own } as CarriedText['overrides'][number]);
    }
  }
  return {
    carriedText: changed.size > 0 ? new CarriedText({ base, overrides: entries }) : undefined,
    rows,
  };
};

/**
 * Puts back the exceptions' own text when `op` is abandoned. A field the
 * user has edited on the exception since keeps the newer value.
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
        if (own !== undefined && stillCarried(row, op, field)) {
          text[field] = own;
        }
      }
      const restored = withText(row, text);
      if (restored !== row) {
        rows.push(restored);
      }
    }
    if (rows.length > 0) {
      yield* eventRepo.upsertMany(rows);
    }
  });
