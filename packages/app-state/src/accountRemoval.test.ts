import { describe, expect, it } from 'vitest';
import { removeAccountQuestion } from './accountRemoval.ts';

const google = { email: 'nik@example.com', id: 'acc-1', provider: 'google' as const };

describe('removeAccountQuestion', () => {
  it('asks before removing a Google account and counts only its unsynced changes', () => {
    expect(removeAccountQuestion(google, [])).toEqual({
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

  it('lets an Apple account go without asking: EventKit keeps its data', () => {
    expect(
      removeAccountQuestion({ email: '', id: 'apple-reminders', provider: 'apple' }, []),
    ).toBeUndefined();
  });
});
