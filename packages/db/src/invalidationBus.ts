/**
 * In-process fan-out for backend invalidation keys: the forwarding
 * Reactivity publishes here; the rpc invalidations stream (desktop) and the
 * in-process atom bridge (iOS) subscribe.
 */
export interface InvalidationBus {
  readonly publish: (keys: ReadonlyArray<unknown>) => void;
  readonly subscribe: (listener: (keys: ReadonlyArray<string>) => void) => () => void;
}

export const makeInvalidationBus = (): InvalidationBus => {
  const listeners = new Set<(keys: ReadonlyArray<string>) => void>();
  return {
    publish: (keys) => {
      const stringKeys = keys.map(String);
      for (const listener of listeners) {
        listener(stringKeys);
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};
