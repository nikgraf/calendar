import { describe, expect, it } from 'vite-plus/test';
import { micPress, pendingLine, shouldListen } from './voiceLoop.ts';

describe('micPress', () => {
  it('starts hands-free when dictation is off', () => {
    expect(micPress({ handsFree: false, voice: 'idle' })).toBe('listen');
  });

  it('sends what was recorded, and listens no further — heard or not: the recognisers can miss a quiet phrase', () => {
    expect(micPress({ handsFree: true, voice: 'recording' })).toBe('send');
  });

  it('ends hands-free while preparing and while a phrase is read', () => {
    expect(micPress({ handsFree: true, voice: 'preparing' })).toBe('end');
    expect(micPress({ handsFree: true, voice: 'transcribing' })).toBe('end');
    // Between phrases, waiting for the form to take the last one.
    expect(micPress({ handsFree: true, voice: 'idle' })).toBe('end');
  });

  it('a phrase still being read after hands-free ended is not a reason to start again', () => {
    expect(micPress({ handsFree: false, voice: 'transcribing' })).toBe('end');
  });
});

describe('shouldListen', () => {
  it('listens again once the last phrase is read and in the form', () => {
    expect(shouldListen({ handsFree: true, hold: false, voice: 'idle' })).toBe(true);
  });

  it('waits while the form still takes the last phrase in', () => {
    expect(shouldListen({ handsFree: true, hold: true, voice: 'idle' })).toBe(false);
  });

  it('never while a phrase is recorded or read, nor once hands-free ended', () => {
    expect(shouldListen({ handsFree: true, hold: false, voice: 'recording' })).toBe(false);
    expect(shouldListen({ handsFree: true, hold: false, voice: 'transcribing' })).toBe(false);
    expect(shouldListen({ handsFree: false, hold: false, voice: 'idle' })).toBe(false);
  });
});

describe('pendingLine', () => {
  it('shows the words while the phrase is spoken', () => {
    expect(pendingLine({ busy: false, live: 'Lunch with Sarah', phrase: '' })).toBe(
      'Lunch with Sarah',
    );
  });

  it('shows the phrase as read while the model reads it', () => {
    expect(pendingLine({ busy: true, live: '', phrase: 'Lunch with Sarah tomorrow at 1' })).toBe(
      'Lunch with Sarah tomorrow at 1',
    );
  });

  it('shows nothing between phrases', () => {
    expect(pendingLine({ busy: false, live: '', phrase: '' })).toBeUndefined();
    expect(pendingLine({ busy: false, live: '  ', phrase: 'typed, not sent' })).toBeUndefined();
  });
});
