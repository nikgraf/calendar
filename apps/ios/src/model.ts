import {
  fixtureTextRecognizer,
  makeFixtureLanguageModel,
  type LanguageModel,
  type TextRecognizer,
} from '@calendar/ai';
import { appleLanguageModel } from './appleModel.ts';
import { iosTextRecognizer } from './textRecognizer.ts';

/**
 * The model and the text recognizer the UI talks to. Normally Apple's
 * on-device Foundation Models and Vision; `EXPO_PUBLIC_CALENDAR_MODEL=fixture`
 * (the e2e bundle, like the Google fixture) swaps in the deterministic
 * fakes from @calendar/ai, so a flow can feed text in the fixture grammar
 * and assert the events. A JS-level fake, not a bridge off switch: iOS has
 * none of those on purpose.
 */
export const modelFixture = process.env['EXPO_PUBLIC_CALENDAR_MODEL'] === 'fixture';

export const languageModel: LanguageModel = modelFixture
  ? makeFixtureLanguageModel()
  : appleLanguageModel;

export const textRecognizer: TextRecognizer = modelFixture
  ? fixtureTextRecognizer
  : iosTextRecognizer;
