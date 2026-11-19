import { type EventDraft, nearestOccurrenceDay, Temporal, toZonedDateTime } from '@calendar/core';
import { useAtomSet, useAtomValue } from '@effect/atom-react';
import { Atom } from 'effect/reactivity';
import { useEffect, useRef } from 'react';

export type CreatedItem =
  | { readonly event: EventDraft; readonly kind: 'event' }
  | { readonly date: string | undefined; readonly kind: 'task' };

/** A successful create's destination, resolved against the calendar as it is now. */
export const createdItemDay = (
  item: CreatedItem,
  first: Temporal.PlainDate,
  last: Temporal.PlainDate,
  timeZone: string,
): Temporal.PlainDate | undefined => {
  if (item.kind === 'task') {
    return item.date === undefined ? undefined : Temporal.PlainDate.from(item.date);
  }
  const event = item.event;
  const start =
    event.isAllDay && event.startDate
      ? Temporal.PlainDate.from(event.startDate)
      : toZonedDateTime(event.startUtc, timeZone).toPlainDate();
  if (event.recurrence?.length) {
    try {
      return (
        nearestOccurrenceDay(
          {
            ...event,
            id: 'created',
            recurrence: event.recurrence,
            startTimeZone: event.startTimeZone ?? timeZone,
          },
          first,
          last,
          timeZone,
        ) ?? start
      );
    } catch {
      // Navigation cannot turn a completed write into an editor failure.
      return start;
    }
  }
  return start;
};

interface CreateRequest {
  readonly item: CreatedItem;
  readonly nonce: number;
}

const createdItemAtom = Atom.make<CreateRequest | null>(null).pipe(Atom.keepAlive);
let nonce = 0;

/** An editor that has gone away must not navigate when its write replies late. */
export const useRevealCreatedItem = (): ((item: CreatedItem) => void) => {
  const set = useAtomSet(createdItemAtom);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  return (item) => {
    if (mounted.current) {
      nonce += 1;
      set({ item, nonce });
    }
  };
};

/** Like draft reveals, old requests are ignored when a calendar mounts. */
export const useOnCreatedItem = (onCreated: (item: CreatedItem) => void): void => {
  const request = useAtomValue(createdItemAtom);
  const seen = useRef(request?.nonce);
  const handler = useRef(onCreated);
  useEffect(() => {
    handler.current = onCreated;
  }, [onCreated]);
  useEffect(() => {
    if (request && request.nonce !== seen.current) {
      seen.current = request.nonce;
      handler.current(request.item);
    }
  }, [request]);
};
