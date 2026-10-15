import { readFileSync } from 'node:fs';

/**
 * CALENDAR_MICROPHONE=fixture: dictation without the Mac's speech
 * models. The e2e harness plays known audio into the page in place of the
 * microphone (`LaunchOptions.microphone`), so the renderer's own recording
 * and pause detection run on it; here nothing is asked or installed, and
 * each transcription answers the fixture's next phrase.
 */
const phrases = ((): ReadonlyArray<string> | undefined => {
  const path = process.env['CALENDAR_MICROPHONE_FIXTURE'];
  if (process.env['CALENDAR_MICROPHONE'] !== 'fixture' || !path) {
    return undefined;
  }
  return (JSON.parse(readFileSync(path, 'utf8')) as { phrases: ReadonlyArray<string> }).phrases;
})();

export const microphoneFixture = phrases !== undefined;

let transcribed = 0;

/** The next phrase "heard", as the helper's transcription answers; nothing once they run out. */
export const nextFixturePhrase = (): { segments: ReadonlyArray<{ text: string }> } => {
  const text = phrases?.[transcribed];
  transcribed += 1;
  return { segments: text === undefined ? [] : [{ text }] };
};
