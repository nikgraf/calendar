import type { WordsSource } from '@calendar/ai';
import type { VoiceState } from './quickAddModel.ts';

/** Where hands-free dictation stands, as the microphone button sees it. */
export interface VoiceLoopState {
  /** Hands-free is on: every pause sends the phrase, and it listens on. */
  readonly handsFree: boolean;
  readonly voice: VoiceState;
}

/**
 * What a press of the microphone does:
 * - `listen` — off: hands-free starts.
 * - `send` — recording: what was said is sent at once, and nothing more
 *   is listened for (the tap is "that's all"). Also before a phrase was
 *   heard — the recognisers can miss a quiet one, and the press must not lose
 *   it; a recording of nothing reads as nothing, without a message.
 * - `end` — preparing, or reading a phrase: hands-free ends (a phrase
 *   being read still lands).
 */
export const micPress = ({ handsFree, voice }: VoiceLoopState): 'end' | 'listen' | 'send' =>
  voice === 'recording' ? 'send' : handsFree || voice !== 'idle' ? 'end' : 'listen';

/** How long the microphone is held before it is a hold, not a tap. */
export const HOLD_MS = 350;

/**
 * What putting a finger (or the mouse button) down on the microphone
 * does: off, it listens at once — whether this is a tap (hands-free) or a
 * hold is known only later, and the words said meanwhile must not be lost.
 */
export const micDown = ({ handsFree, voice }: VoiceLoopState): 'listen' | 'none' =>
  !handsFree && voice === 'idle' ? 'listen' : 'none';

/**
 * What lifting it does. `held`: it was down for `HOLD_MS` or more (hold to
 * talk); `listened`: putting it down started the listening (`micDown`);
 * `clicked`: the press was a tap (its click came). A touch that never
 * became a tap (a swipe of the sheet that began on it, a finger slid off)
 * lifts without one.
 * - `send` — held, and listening: the phrase is sent, through any pause in it.
 * - `end` — held, before the microphone opened: nothing was recorded.
 * - `wait` — not held, no click yet: the click may still follow the
 *   release (`micClick`); without one, nothing was pressed (`tapNeverCame`).
 * - `keep` — a tap that started hands-free: it listens on.
 * - otherwise a tap, as `micPress`.
 */
export const micUp = ({
  clicked,
  handsFree,
  held,
  listened,
  voice,
}: VoiceLoopState & {
  readonly clicked: boolean;
  readonly held: boolean;
  readonly listened: boolean;
}): 'end' | 'keep' | 'listen' | 'send' | 'wait' => {
  if (held) {
    return voice === 'recording' ? 'send' : 'end';
  }
  if (!clicked) {
    return 'wait';
  }
  return listened ? 'keep' : micPress({ handsFree, voice });
};

/**
 * A release whose click never came was no press: the listening it
 * started as the finger went down ends; otherwise nothing happens.
 */
export const tapNeverCame = ({ listened }: { readonly listened: boolean }): 'end' | 'none' =>
  listened ? 'end' : 'none';

/**
 * What "that's all" (a tap while listening, a hold let go of) does with
 * the phrase on its way, if one is:
 * - `land` — nothing was said after it: it lands as it is, and the
 *   microphone closes.
 * - `read` — words followed it (or none is on its way): everything since
 *   the last phrase that landed is read as one phrase, and sent.
 */
export const sendPress = ({
  inFlight,
  saidSince,
}: {
  readonly inFlight: boolean;
  readonly saidSince: boolean;
}): 'land' | 'read' => (inFlight && !saidSince ? 'land' : 'read');

/**
 * How long after the microphone was let go of a click still belongs to
 * that press: a click follows its press's release at once on the Mac,
 * and on iOS a tap shorter than 130 ms sends the press before the release.
 */
export const CLICK_AFTER_UP_MS = 600;

/**
 * What the microphone's click is:
 * - `mark` — a press is down: it is a tap (on iOS a tap shorter than
 *   130 ms clicks before it lifts); the release acts on it.
 * - `confirm` — a release waits for it (`micUp` → `wait`): it acts now.
 * - `ignore` — the press it belongs to was handled already.
 * - `press` — from the keyboard or VoiceOver, alone: a press of its own.
 */
export const micClick = ({
  pressing,
  sinceUpMs,
  waiting,
}: {
  readonly pressing: boolean;
  readonly sinceUpMs: number;
  readonly waiting: boolean;
}): 'confirm' | 'ignore' | 'mark' | 'press' => {
  if (pressing) {
    return 'mark';
  }
  if (waiting) {
    return 'confirm';
  }
  return sinceUpMs < CLICK_AFTER_UP_MS ? 'ignore' : 'press';
};

/**
 * Where the next phrase's words begin once a phrase landed: after all
 * words written by then, words a recogniser wrote late included, or, for
 * a phrase the 60 s cap cut (`forced`), after the words it was cut at —
 * words said past the cap never join it (it would never end), and they
 * are the next phrase.
 */
export const landedWords = ({
  atPause,
  forced,
  now,
}: {
  readonly atPause: WordCounts;
  readonly forced: boolean;
  readonly now: WordCounts;
}): WordCounts => (forced ? atPause : now);

/** Words per recogniser: what each has written, counted as `phraseWords` counts. */
export type WordCounts = Readonly<Record<WordsSource, number>>;

const wordsIn = (text: string): ReadonlyArray<string> => text.split(/\s+/).filter(Boolean);

/** How many words a recogniser's text holds. */
export const wordCount = (text: string): number => wordsIn(text).length;

/**
 * A recogniser's words for the phrase being said: what it wrote since the
 * listening began (it writes all of it, every phrase), less the words of
 * the phrases that landed before (`landed`).
 */
export const phraseWords = (text: string, landed: number): string =>
  wordsIn(text).slice(landed).join(' ');

/**
 * Whether words came after a phrase was sent (`atPause`: the counts when
 * its pause ended): a new word of the quick recogniser, or the accurate
 * one going past what either had heard by then. The accurate recogniser
 * writes in bursts a second behind the quick one: a word of the phrase
 * itself that it writes after the pause is not a new one. Each count is
 * the phrase's own, after the words of the phrases that `landed` before:
 * the two recognisers may have written those as different numbers of
 * words, and only within one phrase are their counts comparable.
 */
export const grewSince = ({
  atPause,
  landed,
  now,
}: {
  readonly atPause: WordCounts;
  readonly landed: WordCounts;
  readonly now: WordCounts;
}): boolean => {
  const before = {
    accurate: atPause.accurate - landed.accurate,
    quick: atPause.quick - landed.quick,
  };
  const after = { accurate: now.accurate - landed.accurate, quick: now.quick - landed.quick };
  return after.quick > before.quick || after.accurate > Math.max(before.accurate, before.quick);
};

/**
 * Hands-free opens the microphone once nothing else is under way: on the
 * first press, and not while the form still takes a phrase in (`hold` is
 * the editor still applying it). Once open it stays open, phrase after
 * phrase, until hands-free ends.
 */
export const shouldListen = ({
  handsFree,
  hold,
  voice,
}: {
  readonly handsFree: boolean;
  readonly hold: boolean;
  readonly voice: VoiceState;
}): boolean => handsFree && !hold && voice === 'idle';

/**
 * What the thread shows for the phrase on its way, if anything: a typed
 * or dictated phrase while the model reads it, else the words of the one
 * being spoken (kept through the moment it is read once more).
 */
export const pendingLine = ({
  busy,
  live,
  phrase,
}: {
  readonly busy: boolean;
  readonly live: string;
  readonly phrase: string;
}): string | undefined => {
  if (busy && phrase.trim() !== '') {
    return phrase;
  }
  return live.trim() === '' ? undefined : live;
};

/**
 * Whether words the editor offers (another reading, `say`) may be said
 * now: not while a phrase is heard (its words on show), read once more
 * (`transcribing`, before any word may have shown) or read by the
 * thread — the phrase on its way would land after them and take their
 * place.
 */
export const maySay = ({
  busy,
  live,
  voice,
}: {
  readonly busy: boolean;
  readonly live: string;
  readonly voice: VoiceState;
}): boolean => !busy && live.trim() === '' && voice !== 'transcribing';
