import { Cause, Option } from 'effect';
import { AsyncResult } from 'effect/reactivity';
import { describe, expect, it } from 'vite-plus/test';
import { pendingOpsRead, removeAccountQuestion } from './accountRemoval.ts';

describe('pendingOpsRead', () => {
  it('is the ops only after a successful read', () => {
    const ops = [{ accountId: 'acc-1' }];
    expect(pendingOpsRead(AsyncResult.initial())).toBe('loading');
    expect(pendingOpsRead(AsyncResult.initial(true))).toBe('loading');
    expect(pendingOpsRead(AsyncResult.success(ops))).toBe(ops);
    expect(pendingOpsRead(AsyncResult.success(ops, { waiting: true }))).toBe(ops);
    expect(pendingOpsRead(AsyncResult.failure<typeof ops, string>(Cause.fail('db')))).toBe(
      'failed',
    );
    // A failed refresh after a good read: the old count may be stale.
    expect(
      pendingOpsRead(
        AsyncResult.failure<typeof ops, string>(Cause.fail('db'), {
          previousSuccess: Option.some(AsyncResult.success(ops)),
        }),
      ),
    ).toBe('failed');
  });
});

const google = { email: 'nik@example.com', id: 'acc-1', provider: 'google' as const };

describe('removeAccountQuestion', () => {
  it('asks before removing a Google account and counts only its unsynced changes', () => {
    expect(removeAccountQuestion(google, [])).toEqual({
      canRemove: true,
      message:
        'This signs out of nik@example.com on this device and deletes its local copy. Your calendars and tasks stay in Google.',
      title: 'Remove nik@example.com?',
    });
    const ops = [{ accountId: 'acc-1' }, { accountId: 'acc-2' }, { accountId: 'acc-1' }];
    expect(removeAccountQuestion(google, ops)?.message).toMatch(
      / 2 changes have not reached Google yet and will be lost\.$/,
    );
    expect(removeAccountQuestion(google, ops.slice(0, 2))?.message).toMatch(
      / 1 change has not reached Google yet/,
    );
  });

  it('offers no removal until the queue was read: an unread queue is not an empty one', () => {
    expect(removeAccountQuestion(google, 'loading')).toEqual({
      canRemove: false,
      message: 'Checking for changes that have not reached Google yet…',
      title: 'Remove nik@example.com?',
    });
    const failed = removeAccountQuestion(google, 'failed');
    expect(failed?.canRemove).toBe(false);
    expect(failed?.message).toMatch(/could not check/);
  });

  it('lets an Apple account go without asking: EventKit keeps its data', () => {
    for (const queue of [[], 'loading', 'failed'] as const) {
      expect(
        removeAccountQuestion({ email: '', id: 'apple-reminders', provider: 'apple' }, queue),
      ).toBeUndefined();
    }
  });
});
