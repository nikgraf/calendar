import { describe, expect, it } from 'vitest';
import {
  type AgentPolicy,
  calendarLevel,
  type CalendarLevel,
  canSeeBusy,
  canSeeDetails,
  decideWrite,
  EMPTY_POLICY,
  type GuestsCapability,
  taskListLevel,
} from './policy.ts';

const policy: AgentPolicy = {
  ...EMPTY_POLICY,
  calendarDefault: 'read',
  calendars: [
    { accountId: 'a', calendarId: 'work', level: 'write' },
    { accountId: 'a', calendarId: 'private', level: 'none' },
  ],
  taskListDefault: 'none',
  taskLists: [{ accountId: 'a', level: 'ask', taskListId: 'inbox' }],
};

describe('levels', () => {
  it('an override wins over the default, per account', () => {
    expect(calendarLevel(policy, { accountId: 'a', calendarId: 'work' })).toBe('write');
    expect(calendarLevel(policy, { accountId: 'a', calendarId: 'private' })).toBe('none');
    // Same calendar id under another account is a different calendar.
    expect(calendarLevel(policy, { accountId: 'b', calendarId: 'work' })).toBe('read');
    expect(taskListLevel(policy, { accountId: 'a', taskListId: 'inbox' })).toBe('ask');
    expect(taskListLevel(policy, { accountId: 'a', taskListId: 'other' })).toBe('none');
  });

  it('a new agent sees nothing', () => {
    expect(calendarLevel(EMPTY_POLICY, { accountId: 'a', calendarId: 'work' })).toBe('none');
    expect(taskListLevel(EMPTY_POLICY, { accountId: 'a', taskListId: 'inbox' })).toBe('none');
    expect(EMPTY_POLICY.contacts).toBe(false);
    expect(EMPTY_POLICY.guests).toBe('off');
  });

  it('details need read; busy time needs free/busy', () => {
    const levels: ReadonlyArray<CalendarLevel> = ['none', 'freeBusy', 'read', 'ask', 'write'];
    expect(levels.map(canSeeBusy)).toEqual([false, true, true, true, true]);
    expect(levels.map(canSeeDetails)).toEqual([false, false, true, true, true]);
  });
});

const decide = (
  level: CalendarLevel,
  options: {
    readonly guests?: GuestsCapability;
    readonly providerWritable?: boolean;
    readonly touchesGuests?: boolean;
  } = {},
) =>
  decideWrite({
    guests: options.guests ?? 'off',
    level,
    providerWritable: options.providerWritable ?? true,
    touchesGuests: options.touchesGuests ?? false,
  });

describe('decideWrite', () => {
  it('follows the level', () => {
    expect(decide('none')).toEqual({ _tag: 'Hidden' });
    expect(decide('freeBusy')).toEqual({ _tag: 'Denied', reason: 'level' });
    expect(decide('read')).toEqual({ _tag: 'Denied', reason: 'level' });
    expect(decide('ask')).toEqual({ _tag: 'Ask' });
    expect(decide('write')).toEqual({ _tag: 'Allow' });
  });

  it('a provider read-only target is never writable, whatever the grant', () => {
    expect(decide('write', { providerWritable: false })).toEqual({
      _tag: 'Denied',
      reason: 'readOnly',
    });
    expect(decide('ask', { providerWritable: false })).toEqual({
      _tag: 'Denied',
      reason: 'readOnly',
    });
    // A hidden target stays hidden: read-only must not confirm it exists.
    expect(decide('none', { providerWritable: false })).toEqual({ _tag: 'Hidden' });
  });

  it('a write that reaches guests needs the guests capability on top', () => {
    expect(decide('write', { touchesGuests: true })).toEqual({ _tag: 'Denied', reason: 'guests' });
    expect(decide('write', { guests: 'ask', touchesGuests: true })).toEqual({ _tag: 'Ask' });
    expect(decide('write', { guests: 'allow', touchesGuests: true })).toEqual({ _tag: 'Allow' });
    // The capability never lifts the calendar level.
    expect(decide('ask', { guests: 'allow', touchesGuests: true })).toEqual({ _tag: 'Ask' });
    expect(decide('read', { guests: 'allow', touchesGuests: true })).toEqual({
      _tag: 'Denied',
      reason: 'level',
    });
  });
});
