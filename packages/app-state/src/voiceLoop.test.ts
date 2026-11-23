import { describe, expect, it } from 'vite-plus/test';
import {
  grewSince,
  maySay,
  micDown,
  micPress,
  micUp,
  pendingLine,
  phraseWords,
  sendPress,
  shouldListen,
  wordCount,
} from './voiceLoop.ts';

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

describe('maySay', () => {
  it('lets offered words be said only while no phrase is heard, read again or read', () => {
    expect(maySay({ busy: false, live: '', voice: 'idle' })).toBe(true);
    // Listening with nothing heard yet: saying them ends hands-free.
    expect(maySay({ busy: false, live: '', voice: 'recording' })).toBe(true);
    expect(maySay({ busy: false, live: 'make it', voice: 'recording' })).toBe(false);
    // Stopped before a word showed: the phrase is still on its way.
    expect(maySay({ busy: false, live: '', voice: 'transcribing' })).toBe(false);
    expect(maySay({ busy: true, live: '', voice: 'idle' })).toBe(false);
  });
});

describe('micDown', () => {
  it('listens as the finger goes down when dictation is off: a tap or a hold, the first words are kept', () => {
    expect(micDown({ handsFree: false, voice: 'idle' })).toBe('listen');
  });

  it('does nothing yet while on or busy: what the press is shows when it lifts', () => {
    expect(micDown({ handsFree: true, voice: 'recording' })).toBe('none');
    expect(micDown({ handsFree: true, voice: 'preparing' })).toBe('none');
    expect(micDown({ handsFree: false, voice: 'transcribing' })).toBe('none');
  });
});

describe('micUp', () => {
  it('a hold sends what was said, however long it paused', () => {
    expect(micUp({ handsFree: true, held: true, listened: true, voice: 'recording' })).toBe('send');
    // Held while hands-free was already on: the hold sends too.
    expect(micUp({ handsFree: true, held: true, listened: false, voice: 'recording' })).toBe(
      'send',
    );
  });

  it('a hold let go of before the microphone opened ends it: nothing was recorded', () => {
    expect(micUp({ handsFree: true, held: true, listened: true, voice: 'preparing' })).toBe('end');
  });

  it('a tap that started listening keeps listening: hands-free', () => {
    expect(micUp({ handsFree: true, held: false, listened: true, voice: 'preparing' })).toBe(
      'keep',
    );
    expect(micUp({ handsFree: true, held: false, listened: true, voice: 'recording' })).toBe(
      'keep',
    );
  });

  it('any other tap is a press', () => {
    expect(micUp({ handsFree: true, held: false, listened: false, voice: 'recording' })).toBe(
      'send',
    );
    expect(micUp({ handsFree: true, held: false, listened: false, voice: 'preparing' })).toBe(
      'end',
    );
  });
});

describe('phraseWords', () => {
  it('is what the recogniser wrote after the phrases that landed', () => {
    expect(phraseWords('Lunch tomorrow at one make it two', 4)).toBe('make it two');
    expect(phraseWords('Lunch tomorrow', 0)).toBe('Lunch tomorrow');
  });

  it('is nothing until a word follows them', () => {
    expect(phraseWords('Lunch tomorrow ', 2)).toBe('');
    expect(phraseWords('', 0)).toBe('');
  });

  it('counts words as it drops them', () => {
    expect(wordCount('  Lunch   tomorrow at one ')).toBe(4);
    expect(phraseWords('  Lunch   tomorrow at one ', wordCount('Lunch tomorrow'))).toBe('at one');
  });
});

describe('grewSince', () => {
  const atPause = { accurate: 3, quick: 4 };

  it('a new word of the quick recogniser is the phrase going on', () => {
    expect(grewSince(atPause, { accurate: 3, quick: 5 })).toBe(true);
  });

  it('the accurate one catching up with the quick one after the pause is not', () => {
    expect(grewSince(atPause, { accurate: 4, quick: 4 })).toBe(false);
  });

  it('the accurate one going past both is', () => {
    expect(grewSince(atPause, { accurate: 5, quick: 4 })).toBe(true);
  });

  it('without the quick one, any word of the accurate one is', () => {
    expect(grewSince({ accurate: 3, quick: 0 }, { accurate: 4, quick: 0 })).toBe(true);
    expect(grewSince({ accurate: 3, quick: 0 }, { accurate: 3, quick: 0 })).toBe(false);
  });

  it('a punctuation pass or a revision that drops a word is not', () => {
    expect(grewSince(atPause, { accurate: 2, quick: 4 })).toBe(false);
  });
});

describe('sendPress', () => {
  it('lets a phrase on its way land when nothing followed it', () => {
    expect(sendPress({ inFlight: true, saidSince: false })).toBe('land');
  });

  it('reads it again with what followed', () => {
    expect(sendPress({ inFlight: true, saidSince: true })).toBe('read');
  });

  it('reads what is being said when no phrase is on its way', () => {
    expect(sendPress({ inFlight: false, saidSince: true })).toBe('read');
    expect(sendPress({ inFlight: false, saidSince: false })).toBe('read');
  });
});
