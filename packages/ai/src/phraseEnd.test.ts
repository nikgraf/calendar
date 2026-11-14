import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import {
  createPhraseEnd,
  listenForPhrase,
  PHRASE_CHECK_MS,
  PHRASE_END_DEFAULTS,
  type PhraseEvent,
  type WordsSource,
} from './phraseEnd.ts';
import { RECORDINGS, type Recording } from './phraseEndRecordings.ts';

/** How often the app asks whether the phrase ended. */
const CHECK_MS = 50;

/** Plays a recording into the ear; where it ended, and what it showed then. */
const replay = (recording: Recording, hear: (source: WordsSource) => boolean = () => true) => {
  const ear = createPhraseEnd();
  const events: Array<{ readonly at: number; readonly event: PhraseEvent }> = [];
  const first = recording.words[0]?.[0] ?? 0;
  const last = recording.words.at(-1)?.[0] ?? 0;
  let next = 0;
  let shown = '';
  for (let at = first; at <= last + 5000; at += CHECK_MS) {
    while (next < recording.words.length && (recording.words[next]?.[0] ?? 0) <= at) {
      const [ms, source, text] = recording.words[next] ?? [0, 'quick', ''];
      next += 1;
      if (!hear(source)) {
        continue;
      }
      const event = ear.words(source, text, ms);
      if (event) {
        events.push({ at: ms, event });
      }
    }
    const event = ear.check(at);
    if (event) {
      events.push({ at, event });
      shown = ear.text();
      break;
    }
  }
  return { end: events.find((entry) => entry.event === 'end')?.at, events, shown };
};

const named = (name: string): Recording => {
  const recording = RECORDINGS.find((entry) => entry.name === name);
  if (!recording) {
    throw new Error(`no recording ${name}`);
  }
  return recording;
};

describe('createPhraseEnd on recorded phrases', () => {
  it.each(RECORDINGS.map((recording) => [recording.name, recording] as const))(
    'ends %s after its last word, never before',
    (_name, recording) => {
      const { end, events } = replay(recording);
      expect(events.map((entry) => entry.event)).toEqual(['start', 'end']);
      const [, spokenUntil] = recording.speech;
      expect(end).toBeGreaterThan(spokenUntil);
      expect(end).toBeLessThan(spokenUntil + 2600);
    },
  );

  it('ends a phrase in a quiet room as quickly as the loudness did', () => {
    // The loudness rule ended it 1.3 s after the last word.
    for (const name of ['lunch-sarah (clean)', 'drinks-jo (clean)']) {
      const recording = named(name);
      expect(replay(recording).end).toBeLessThan(recording.speech[1] + 1600);
    }
  });

  it('waits for the accurate words when the quick ones go deaf in a crowd', () => {
    // The quick recogniser wrote "Coffee with" and nothing more; ending
    // on it alone cut the phrase in half.
    for (const name of ['kaffemik (babble-3)', 'invite-tom (babble-3)']) {
      const recording = named(name);
      const [, spokenUntil] = recording.speech;
      expect(replay(recording, (source) => source === 'quick').end).toBeLessThan(spokenUntil);
      expect(replay(recording).end).toBeGreaterThan(spokenUntil);
    }
  });

  it('shows the accurate reading as far as it goes', () => {
    expect(replay(named('lunch-sarah (clean)')).shown).toBe('Lunch with Sarah tomorrow at 1');
  });
});

describe('createPhraseEnd', () => {
  const { accuratePauseMs, quickPauseMs } = PHRASE_END_DEFAULTS;

  it('starts at the first word, once', () => {
    const ear = createPhraseEnd();
    expect(ear.heard()).toBe(false);
    expect(ear.words('quick', '', 0)).toBeUndefined();
    expect(ear.words('quick', ' . ', 10)).toBeUndefined();
    expect(ear.heard()).toBe(false);
    expect(ear.words('accurate', 'Lunch', 20)).toBe('start');
    expect(ear.words('quick', 'Lunch with', 30)).toBeUndefined();
    expect(ear.heard()).toBe(true);
  });

  it('never ends before a word was heard', () => {
    const ear = createPhraseEnd();
    expect(ear.check(60_000)).toBeUndefined();
  });

  it('holds the phrase open through a pause shorter than its end', () => {
    const ear = createPhraseEnd();
    ear.words('quick', 'Lunch with Sarah', 0);
    expect(ear.check(quickPauseMs - 50)).toBeUndefined();
    ear.words('quick', 'Lunch with Sarah tomorrow', quickPauseMs - 50);
    expect(ear.check(quickPauseMs + 100)).toBeUndefined();
    expect(ear.check(2 * quickPauseMs - 50)).toBe('end');
  });

  it('ends once, and hears nothing after', () => {
    const ear = createPhraseEnd();
    ear.words('quick', 'Lunch', 0);
    expect(ear.check(quickPauseMs)).toBe('end');
    expect(ear.check(quickPauseMs + 50)).toBeUndefined();
    expect(ear.words('quick', 'Lunch with', quickPauseMs + 100)).toBeUndefined();
    expect(ear.text()).toBe('Lunch');
  });

  it('does not count punctuation or case as new words', () => {
    const ear = createPhraseEnd();
    ear.words('quick', 'lunch with sarah', 0);
    ear.words('quick', 'Lunch with Sarah.', 500);
    expect(ear.check(quickPauseMs)).toBe('end');
    expect(ear.text()).toBe('Lunch with Sarah.');
  });

  it('lets the accurate words decide when they are ahead', () => {
    const ear = createPhraseEnd();
    ear.words('quick', 'Coffee with', 0);
    ear.words('accurate', 'Coffee with Stefan at', 400);
    // The quick words stood still long enough, but the accurate ones are
    // two words ahead and still moving.
    expect(ear.check(quickPauseMs + 100)).toBeUndefined();
    ear.words('accurate', 'Coffee with Stefan at Kaffemik on Thursday', 1400);
    expect(ear.check(1400 + accuratePauseMs - 50)).toBeUndefined();
    expect(ear.check(1400 + accuratePauseMs)).toBe('end');
  });

  it('ends on the accurate words alone when the quick one writes nothing', () => {
    const ear = createPhraseEnd();
    ear.words('accurate', 'Lunch with Sarah', 0);
    expect(ear.check(accuratePauseMs - 50)).toBeUndefined();
    expect(ear.check(accuratePauseMs)).toBe('end');
  });

  it('ends a one-word phrase when only the accurate recogniser listens, after a longer pause', () => {
    // "Tomorrow" as a change, the quick recogniser not installed. A lone
    // word waits longer: a crowd's "Mm" stood 2.9 s before the phrase.
    const { lonePauseMs } = PHRASE_END_DEFAULTS;
    const ear = createPhraseEnd();
    ear.listensWith(['accurate']);
    ear.words('accurate', 'Mm', 0);
    expect(ear.check(2900)).toBeUndefined();
    ear.words('accurate', 'Mm Tomorrow', 2900);
    expect(ear.check(2900 + accuratePauseMs - 50)).toBeUndefined();
    expect(ear.check(2900 + accuratePauseMs)).toBe('end');

    const lone = createPhraseEnd();
    lone.listensWith(['accurate']);
    lone.words('accurate', 'Tomorrow.', 0);
    expect(lone.check(lonePauseMs - 50)).toBeUndefined();
    expect(lone.check(lonePauseMs)).toBe('end');
  });

  it('takes a word the accurate recogniser alone heard for the room while both listen', () => {
    // The crowd's "Mm" before anyone spoke to the app.
    const ear = createPhraseEnd();
    ear.words('accurate', 'Mm', 0);
    expect(ear.check(10_000)).toBeUndefined();
  });

  it('shows the accurate words, then the quick ones beyond them', () => {
    const ear = createPhraseEnd();
    ear.words('quick', 'Lunch with Sara tomorrow at', 0);
    expect(ear.text()).toBe('Lunch with Sara tomorrow at');
    ear.words('accurate', 'Lunch with Sarah', 10);
    expect(ear.text()).toBe('Lunch with Sarah tomorrow at');
    ear.words('accurate', 'Lunch with Sarah tomorrow at one.', 20);
    expect(ear.text()).toBe('Lunch with Sarah tomorrow at one.');
  });
});

describe('listenForPhrase', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls the end once the words stood still, then stops asking', () => {
    vi.useFakeTimers();
    let ends = 0;
    const ear = listenForPhrase(() => {
      ends += 1;
    });
    expect(ear.words('quick', 'Lunch with Sarah')).toBe('start');
    vi.advanceTimersByTime(PHRASE_END_DEFAULTS.quickPauseMs - PHRASE_CHECK_MS);
    expect(ends).toBe(0);
    vi.advanceTimersByTime(2 * PHRASE_CHECK_MS);
    expect(ends).toBe(1);
    vi.advanceTimersByTime(10_000);
    expect(ends).toBe(1);
    expect(ear.text()).toBe('Lunch with Sarah');
  });

  it('calls nothing once stopped', () => {
    vi.useFakeTimers();
    let ends = 0;
    const ear = listenForPhrase(() => {
      ends += 1;
    });
    ear.words('quick', 'Lunch');
    ear.stop();
    vi.advanceTimersByTime(10_000);
    expect(ends).toBe(0);
  });
});
