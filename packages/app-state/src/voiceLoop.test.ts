import { describe, expect, it } from 'vite-plus/test';
import { micPress, shouldListen } from './voiceLoop.ts';

describe('micPress', () => {
  it('starts hands-free when dictation is off', () => {
    expect(micPress({ handsFree: false, heard: false, voice: 'idle' })).toBe('listen');
  });

  it('sends the phrase mid-sentence, and listens no further', () => {
    expect(micPress({ handsFree: true, heard: true, voice: 'recording' })).toBe('send');
  });

  it('ends hands-free while nothing was said, while preparing, and while a phrase is read', () => {
    expect(micPress({ handsFree: true, heard: false, voice: 'recording' })).toBe('end');
    expect(micPress({ handsFree: true, heard: false, voice: 'preparing' })).toBe('end');
    expect(micPress({ handsFree: true, heard: false, voice: 'transcribing' })).toBe('end');
    // Between phrases, waiting for the form to take the last one.
    expect(micPress({ handsFree: true, heard: false, voice: 'idle' })).toBe('end');
  });

  it('a phrase still being read after hands-free ended is not a reason to start again', () => {
    expect(micPress({ handsFree: false, heard: false, voice: 'transcribing' })).toBe('end');
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
