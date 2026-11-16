import type { VoiceState } from './quickAddModel.ts';

/** Where hands-free dictation stands, as the microphone button sees it. */
export interface VoiceLoopState {
  /** Hands-free is on: every pause sends the phrase, then it listens again. */
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

/**
 * Hands-free listens again once the last phrase is done with: read, and
 * landed in the form (`hold` is the editor still applying it — a phrase
 * sent earlier would read the form as it was).
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
