import { useReducer, useRef } from 'react';

/**
 * Where one async action of a component stands — a save, a delete, an
 * import. One value instead of a `busy` flag beside an `error`: it cannot
 * be running and failed at once, and a retry cannot show the last run's
 * message. `done` stays until the next run, so a control that closes its
 * surface on success can stay off while it leaves.
 */
export type ActionState<A = void> =
  | { readonly kind: 'idle' }
  | { readonly kind: 'running' }
  | { readonly kind: 'failed'; readonly message: string }
  | { readonly kind: 'done'; readonly value: A };

export type ActionEvent<A = void> =
  | { readonly kind: 'started' }
  | { readonly kind: 'succeeded'; readonly value: A }
  | { readonly kind: 'failed'; readonly message: string };

/**
 * A run starts from any state but a running one, and only a running
 * action ends: an event that fits no run is dropped, the state returned
 * as it was.
 */
export const actionReducer = <A>(state: ActionState<A>, event: ActionEvent<A>): ActionState<A> => {
  if (event.kind === 'started') {
    return state.kind === 'running' ? state : { kind: 'running' };
  }
  if (state.kind !== 'running') {
    return state;
  }
  return event.kind === 'succeeded'
    ? { kind: 'done', value: event.value }
    : { kind: 'failed', message: event.message };
};

/** What a thrown value says, as the line a failed action shows. */
export const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/**
 * One run of `task`, told to `dispatch` as it goes. A run already under
 * way wins: the second call returns without starting `task`. `lock`
 * decides that, not the state — two calls in one frame both see the last
 * render's state. Never rejects: a throw becomes the `failed` event.
 */
export const runAction = async <A>(
  lock: { current: boolean },
  dispatch: (event: ActionEvent<A>) => void,
  task: () => Promise<A>,
  describe: (error: unknown) => string = errorMessage,
): Promise<void> => {
  if (lock.current) {
    return;
  }
  lock.current = true;
  dispatch({ kind: 'started' });
  try {
    const value = await task();
    dispatch({ kind: 'succeeded', value });
  } catch (error) {
    dispatch({ kind: 'failed', message: describe(error) });
  } finally {
    lock.current = false;
  }
};

export interface ActionHandle<A = void> {
  /** The action is running: its controls are off. */
  readonly busy: boolean;
  /** Why the last run failed, until the next one starts. */
  readonly error: string | null;
  /** Runs `task` unless a run is under way; its outcome lands in `state`. */
  readonly run: (task: () => Promise<A>) => Promise<void>;
  readonly state: ActionState<A>;
}

/**
 * An async action of a component, one run at a time. `task` does the work
 * and what follows it (closing the dialog, taking the result into other
 * state); what it returns is the `done` state's value. `describe` turns a
 * throw into the failure's line.
 */
export const useAction = <A = void>(
  describe: (error: unknown) => string = errorMessage,
): ActionHandle<A> => {
  const [state, dispatch] = useReducer(actionReducer<A>, { kind: 'idle' });
  const lock = useRef(false);
  return {
    busy: state.kind === 'running',
    error: state.kind === 'failed' ? state.message : null,
    run: (task) => runAction(lock, dispatch, task, describe),
    state,
  };
};
