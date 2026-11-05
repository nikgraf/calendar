import { useReducer, useRef } from 'react';
import { runOneWrite, type WriteSlot } from './oneWrite.ts';

/**
 * Where one async action of a component stands — a save, a delete, an
 * import. One value instead of a `busy` flag beside an `error`: it cannot
 * be running and failed at once, and a retry cannot show the last run's
 * message. `done` keeps what the task returned until the next run; the
 * action can run again from it, so its controls are back on. A surface
 * that closes on success has to be gone by then (every one here unmounts
 * in the task), or keep its control off through `done` itself.
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
 * way wins, by the editors' rule (`runOneWrite`): the second call starts
 * nothing and gets the running one's promise, so awaiting it waits for
 * that run. The slot decides, not the state — two calls in one frame both
 * see the last render's state. What `task` throws becomes the `failed`
 * event, never a rejection.
 */
export const runAction = <A>(
  slot: WriteSlot,
  dispatch: (event: ActionEvent<A>) => void,
  task: () => Promise<A>,
  describe: (error: unknown) => string = errorMessage,
): Promise<void> =>
  runOneWrite(slot, async () => {
    dispatch({ kind: 'started' });
    try {
      dispatch({ kind: 'succeeded', value: await task() });
    } catch (error) {
      dispatch({ kind: 'failed', message: describe(error) });
    }
  });

export interface ActionHandle<A = void> {
  /** The action is running: its controls are off. */
  readonly busy: boolean;
  /** Why the last run failed, until the next one starts. */
  readonly error: string | null;
  /** Runs `task` unless a run is under way (then it waits for that one); the outcome lands in `state`. */
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
  const slot = useRef<WriteSlot>({ current: null });
  return {
    busy: state.kind === 'running',
    error: state.kind === 'failed' ? state.message : null,
    run: (task) => runAction(slot.current, dispatch, task, describe),
    state,
  };
};
