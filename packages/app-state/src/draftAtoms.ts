import { type FreeSlot, Temporal } from '@calendar/core';
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import { Atom } from 'effect/reactivity';
import { useEffect, useRef } from 'react';
import type { DraftPreview } from './draftPreview.ts';

/**
 * What passes between an open editor's thread and the calendar behind it
 * — on both apps the calendar and the editor are siblings, not parent
 * and child: the drafts to draw, a day to show, a draft block clicked.
 * Plain atoms, kept alive so a value set before its reader mounts is
 * still there.
 */

/** A click on a draft block: the editor focuses that draft (the nonce makes each click count). */
export interface DraftFocusRequest {
  readonly id: string;
  readonly nonce: number;
  /** A candidate block was clicked: the free slot to move the draft into. */
  readonly slot?: FreeSlot | undefined;
}

interface RevealRequest {
  readonly date: string;
  readonly nonce: number;
}

const draftPreviewsAtom = Atom.make<ReadonlyArray<DraftPreview>>([]).pipe(Atom.keepAlive);
const draftRevealAtom = Atom.make<RevealRequest | null>(null).pipe(Atom.keepAlive);
const draftFocusAtom = Atom.make<DraftFocusRequest | null>(null).pipe(Atom.keepAlive);

let nonce = 0;
const nextNonce = (): number => {
  nonce += 1;
  return nonce;
};

/** The open editor's drafts, as the calendar draws them; [] without one. */
export const useDraftPreviews = (): ReadonlyArray<DraftPreview> => useAtomValue(draftPreviewsAtom);

/** The editor's side: publishes its drafts. */
export const useSetDraftPreviews = (): ((previews: ReadonlyArray<DraftPreview>) => void) =>
  useAtomSet(draftPreviewsAtom);

/** The editor's side: asks the calendar to show a day (the focused draft's, a slot's). */
export const useRevealDraftDay = (): ((date: Temporal.PlainDate) => void) => {
  const set = useAtomSet(draftRevealAtom);
  return (date) => set({ date: date.toString(), nonce: nextNonce() });
};

/**
 * The calendar's side: runs `onReveal` for each day asked for after it
 * mounted — never for a request made before (a calendar mounting late
 * must not jump to an old draft's day).
 */
export const useOnDraftReveal = (onReveal: (date: Temporal.PlainDate) => void): void => {
  const reveal = useAtomValue(draftRevealAtom);
  const seen = useRef(reveal?.nonce);
  const handler = useRef(onReveal);
  useEffect(() => {
    handler.current = onReveal;
  }, [onReveal]);
  useEffect(() => {
    if (reveal && reveal.nonce !== seen.current) {
      seen.current = reveal.nonce;
      handler.current(Temporal.PlainDate.from(reveal.date));
    }
  }, [reveal]);
};

/** The calendar's side: a draft block (or a free slot beside one) was clicked. */
export const useRequestDraftFocus = (): ((id: string, slot?: FreeSlot) => void) => {
  const set = useAtomSet(draftFocusAtom);
  return (id, slot) => set({ id, nonce: nextNonce(), ...(slot ? { slot } : {}) });
};

/** The editor's side: the latest click on a draft block, if any. */
export const useDraftFocusRequest = (): DraftFocusRequest | null => useAtomValue(draftFocusAtom);
