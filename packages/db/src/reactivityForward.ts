import { Effect, Layer } from 'effect';
import { make as makeReactivity, Reactivity } from 'effect/unstable/reactivity/Reactivity';

type Keys = ReadonlyArray<unknown> | Readonly<Record<string, ReadonlyArray<unknown>>>;

const flattenKeys = (keys: Keys): ReadonlyArray<unknown> =>
  Array.isArray(keys)
    ? keys
    : Object.entries(keys as Readonly<Record<string, ReadonlyArray<unknown>>>).flatMap(
        ([namespace, values]) => values.map((value) => `${namespace}:${String(value)}`),
      );

/**
 * A Reactivity whose invalidations are also reported to `onInvalidate` — the
 * bridge that carries backend-side invalidation keys to the UI atom runtime
 * (over IPC on desktop, in-process on iOS).
 */
export const forwardingReactivity = (
  onInvalidate: (keys: ReadonlyArray<unknown>) => void,
): Layer.Layer<Reactivity> =>
  Layer.effect(Reactivity)(
    Effect.map(makeReactivity, (reactivity) => ({
      ...reactivity,
      invalidate: (keys: Keys) =>
        Effect.tap(reactivity.invalidate(keys), () =>
          Effect.sync(() => onInvalidate(flattenKeys(keys))),
        ),
      invalidateUnsafe: (keys: Keys) => {
        reactivity.invalidateUnsafe(keys);
        onInvalidate(flattenKeys(keys));
      },
      mutation: <A, E, R>(keys: Keys, effect: Effect.Effect<A, E, R>) =>
        Effect.tap(reactivity.mutation(keys, effect), () =>
          Effect.sync(() => onInvalidate(flattenKeys(keys))),
        ),
    })),
  );
