import { describe, expect, it } from 'vite-plus/test';
import {
  type ActionEvent,
  actionReducer,
  type ActionState,
  errorMessage,
  runAction,
} from './action.ts';

/** A component's side of `useAction`, without React: the state the events fold into. */
const harness = <A>() => {
  const lock = { current: false };
  const seen: Array<ActionState<A>> = [{ kind: 'idle' }];
  const dispatch = (event: ActionEvent<A>) => {
    seen.push(actionReducer(seen.at(-1)!, event));
  };
  return {
    run: (task: () => Promise<A>, describe?: (error: unknown) => string) =>
      runAction(lock, dispatch, task, describe),
    seen,
    state: () => seen.at(-1)!,
  };
};

/** A task that waits to be settled by the test. */
const deferred = <A>() => {
  let resolve!: (value: A) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<A>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, reject, resolve };
};

describe('actionReducer', () => {
  it('starts a run from idle, from a failure and from a finished run', () => {
    const running = { kind: 'running' };
    expect(actionReducer({ kind: 'idle' }, { kind: 'started' })).toEqual(running);
    expect(actionReducer({ kind: 'failed', message: 'No.' }, { kind: 'started' })).toEqual(running);
    expect(actionReducer({ kind: 'done', value: 1 }, { kind: 'started' })).toEqual(running);
  });

  it('ends only a running action: an outcome that fits no run changes nothing', () => {
    const states: ReadonlyArray<ActionState<number>> = [
      { kind: 'idle' },
      { kind: 'failed', message: 'No.' },
      { kind: 'done', value: 1 },
    ];
    for (const state of states) {
      expect(actionReducer(state, { kind: 'succeeded', value: 2 })).toBe(state);
      expect(actionReducer(state, { kind: 'failed', message: 'Late.' })).toBe(state);
    }
  });

  it('keeps a running action running when it is started again', () => {
    const state: ActionState = { kind: 'running' };
    expect(actionReducer(state, { kind: 'started' })).toBe(state);
  });
});

describe('runAction', () => {
  it('runs, then keeps what the task returned', async () => {
    const action = harness<string>();
    await action.run(() => Promise.resolve('Saved.'));
    expect(action.seen).toEqual([
      { kind: 'idle' },
      { kind: 'running' },
      { kind: 'done', value: 'Saved.' },
    ]);
  });

  it('turns a throw into the failure’s line and never rejects', async () => {
    const action = harness();
    await action.run(() => Promise.reject(new Error('The calendar is read-only.')));
    expect(action.state()).toEqual({ kind: 'failed', message: 'The calendar is read-only.' });
  });

  it('describes a failure the way the caller asks', async () => {
    const action = harness();
    await action.run(() => Promise.reject(new Error('Offline.')), String);
    expect(action.state()).toEqual({ kind: 'failed', message: 'Error: Offline.' });
  });

  it('a retry drops the last failure as it starts: never running with the old message', async () => {
    const action = harness();
    await action.run(() => Promise.reject(new Error('Offline.')));
    const second = deferred<void>();
    const retry = action.run(() => second.promise);
    expect(action.state()).toEqual({ kind: 'running' });
    second.resolve();
    await retry;
    expect(action.state()).toEqual({ kind: 'done', value: undefined });
  });

  it('a second run while the first is under way never starts its task', async () => {
    const action = harness<string>();
    const first = deferred<string>();
    const running = action.run(() => first.promise);
    let started = false;
    await action.run(() => {
      started = true;
      return Promise.resolve('second');
    });
    expect(started).toBe(false);
    first.resolve('first');
    await running;
    expect(action.seen).toEqual([
      { kind: 'idle' },
      { kind: 'running' },
      { kind: 'done', value: 'first' },
    ]);
  });

  it('runs again once the last run is over, failed or done', async () => {
    const action = harness<number>();
    await action.run(() => Promise.resolve(1));
    await action.run(() => Promise.reject(new Error('No.')));
    await action.run(() => Promise.resolve(3));
    expect(action.state()).toEqual({ kind: 'done', value: 3 });
  });
});

describe('errorMessage', () => {
  it('reads an Error’s message and anything else as text', () => {
    expect(errorMessage(new Error('Not found.'))).toBe('Not found.');
    expect(errorMessage('plain')).toBe('plain');
  });
});
