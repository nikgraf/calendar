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
 *   heard — the level can miss a quiet one, and the press must not lose
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
