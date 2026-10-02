import type { MirrorMarker } from './marker.ts';
import type { MirrorCopy } from './transform.ts';
import { type MirrorWindow, startsInMirrorWindow } from './window.ts';

/**
 * A marked event found in the destination: possibly one of this mirror's
 * copies, possibly another mirror's. `Ref` is whatever the provider needs
 * to write to it again (a Google row's etag, an EventKit occurrence).
 */
export interface MirrorActual<Ref> {
  readonly allDay: boolean;
  readonly endDate?: string | undefined;
  readonly endUtc: number;
  readonly keyHash: string;
  readonly marker: MirrorMarker;
  /**
   * Orders two events with the same key the same way on every device, so
   * two devices healing a duplicate keep the same one.
   */
  readonly order: string;
  readonly ref: Ref;
  readonly startDate?: string | undefined;
  readonly startUtc: number;
}

export type MirrorOp<Ref> =
  | { readonly copy: MirrorCopy; readonly kind: 'create' }
  | { readonly actual: MirrorActual<Ref>; readonly kind: 'delete' }
  /**
   * A second event under a key that already has one — two devices raced,
   * or someone duplicated a copy. The provider side removes it only when
   * it is indistinguishable from the kept one; otherwise it is somebody's
   * event now and only loses its marker.
   */
  | {
      readonly actual: MirrorActual<Ref>;
      readonly kept: MirrorActual<Ref>;
      readonly kind: 'duplicate';
    }
  | { readonly actual: MirrorActual<Ref>; readonly copy: MirrorCopy; readonly kind: 'update' };

export interface MirrorPlan<Ref> {
  /** Marked events another mirror wrote: this destination is taken. */
  readonly foreign: number;
  /** The highest definition revision stamped on this mirror's copies; 0 when there are none. */
  readonly newestRev: number;
  /** Writes in the order to make them: nearest to now first. */
  readonly ops: ReadonlyArray<MirrorOp<Ref>>;
  /** How many of this mirror's copies the window holds now. */
  readonly present: number;
  /** How many of them the plan would delete. */
  readonly removals: number;
  /** Copies that are already right. */
  readonly unchanged: number;
}

const toSecond = (ms: number): number => Math.round(ms / 1000) * 1000;

/** Whether the event still sits where the copy belongs. */
const sameTimes = <Ref>(copy: MirrorCopy, actual: MirrorActual<Ref>): boolean =>
  copy.allDay === actual.allDay &&
  (copy.allDay
    ? copy.startDate === actual.startDate && copy.endDate === actual.endDate
    : copy.startUtc === toSecond(actual.startUtc) && copy.endUtc === toSecond(actual.endUtc));

const startOf = <Ref>(op: MirrorOp<Ref>): number =>
  op.kind === 'create' || op.kind === 'update' ? op.copy.startUtc : op.actual.startUtc;

/**
 * What to write so the destination holds exactly `desired`. Stateless: it
 * compares what should exist with what the destination carries, so any
 * device can run it and a run that was cut off just plans again.
 *
 * Only this mirror's copies that start inside the window are ever touched.
 * A copy is unchanged when its marker's content hash and its times match —
 * decided from what the mirror wrote, not from fields the provider may
 * have normalised. After a definition change at least one copy is stamped
 * with the new revision even when nothing else changed, so a device still
 * on the old definition can tell and stand back.
 */
export const planMirror = <Ref>(input: {
  readonly actual: ReadonlyArray<MirrorActual<Ref>>;
  readonly desired: ReadonlyArray<MirrorCopy>;
  readonly nowMs: number;
  readonly rev: number;
  readonly tag: string;
  readonly window: MirrorWindow;
}): MirrorPlan<Ref> => {
  const mine = input.actual.filter((actual) => actual.marker.tag === input.tag);
  const foreign = input.actual.length - mine.length;
  const newestRev = mine.reduce((max, actual) => Math.max(max, actual.marker.rev), 0);

  const inWindow = mine.filter((actual) => startsInMirrorWindow(input.window, actual));
  const byKey = new Map<string, MirrorActual<Ref>>();
  const ops: Array<MirrorOp<Ref>> = [];
  const ordered = [...inWindow].sort((a, b) =>
    a.order < b.order ? -1 : a.order > b.order ? 1 : 0,
  );
  for (const actual of ordered) {
    const kept = byKey.get(actual.keyHash);
    if (kept === undefined) {
      byKey.set(actual.keyHash, actual);
    } else {
      ops.push({ actual, kept, kind: 'duplicate' });
    }
  }

  const unchanged: Array<MirrorActual<Ref>> = [];
  let stamped = false;
  const wanted = new Set<string>();
  for (const copy of input.desired) {
    wanted.add(copy.keyHash);
    const actual = byKey.get(copy.keyHash);
    if (actual === undefined) {
      ops.push({ copy, kind: 'create' });
      stamped = true;
    } else if (actual.marker.contentHash !== copy.contentHash || !sameTimes(copy, actual)) {
      ops.push({ actual, copy, kind: 'update' });
      stamped = true;
    } else {
      unchanged.push(actual);
      stamped ||= actual.marker.rev === input.rev;
    }
  }
  let removals = 0;
  for (const actual of byKey.values()) {
    if (!wanted.has(actual.keyHash)) {
      ops.push({ actual, kind: 'delete' });
      removals++;
    }
  }

  // The revision carrier: nothing written or kept bears this revision yet.
  if (!stamped && unchanged.length > 0) {
    const carrier = unchanged.reduce((best, actual) => {
      const upcoming = (candidate: MirrorActual<Ref>) => candidate.startUtc >= input.nowMs;
      if (upcoming(actual) !== upcoming(best)) {
        return upcoming(actual) ? actual : best;
      }
      return Math.abs(actual.startUtc - input.nowMs) < Math.abs(best.startUtc - input.nowMs)
        ? actual
        : best;
    });
    const copy = input.desired.find((entry) => entry.keyHash === carrier.keyHash);
    if (copy !== undefined) {
      ops.push({ actual: carrier, copy, kind: 'update' });
      unchanged.splice(unchanged.indexOf(carrier), 1);
    }
  }

  ops.sort((a, b) => Math.abs(startOf(a) - input.nowMs) - Math.abs(startOf(b) - input.nowMs));
  return {
    foreign,
    newestRev,
    ops,
    present: inWindow.length,
    removals,
    unchanged: unchanged.length,
  };
};
