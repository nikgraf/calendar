import { describe, expect, it } from 'vite-plus/test';
import {
  AUTOMATIC,
  languageOptions,
  listenedLocale,
  OFF,
  readLanguage,
  readSecondLanguage,
  secondAfter,
  secondLanguageNow,
} from './dictationLanguages.ts';

const names: Record<string, string> = {
  'de-AT': 'German (Austria)',
  'de-DE': 'German (Germany)',
  'en-GB': 'English (United Kingdom)',
  'en-US': 'English (United States)',
  'fr-FR': 'French (France)',
};
const nameOf = (id: string) => names[id] ?? id;

describe('readLanguage', () => {
  it('keeps a language id and reads anything else as automatic', () => {
    expect(readLanguage('de-AT')).toBe('de-AT');
    expect(readLanguage('fr')).toBe('fr');
    expect(readLanguage(undefined)).toBe(AUTOMATIC);
    expect(readLanguage('')).toBe(AUTOMATIC);
    expect(readLanguage('de_AT; rm')).toBe(AUTOMATIC);
    expect(readLanguage(OFF)).toBe('off');
  });

  it('lets only the second language be off', () => {
    expect(readSecondLanguage(OFF)).toBe(OFF);
    expect(readSecondLanguage('en-US')).toBe('en-US');
    expect(readSecondLanguage(3)).toBe(AUTOMATIC);
  });
});

describe('listenedLocale', () => {
  it('is the device’s language until one is picked', () => {
    expect(listenedLocale(AUTOMATIC, 'en-US')).toBe('en-US');
    expect(listenedLocale('de-AT', 'en-US')).toBe('de-AT');
  });
});

describe('languageOptions', () => {
  it('lists the languages by name', () => {
    expect(
      languageOptions(['fr-FR', 'en-US', 'de-AT'], AUTOMATIC, nameOf).map((o) => o.id),
    ).toEqual(['en-US', 'fr-FR', 'de-AT'].sort((a, b) => nameOf(a).localeCompare(nameOf(b))));
  });

  it('keeps the one picked when the recogniser no longer lists it', () => {
    expect(languageOptions(['en-US'], 'de-AT', nameOf).map((o) => o.id)).toEqual([
      'en-US',
      'de-AT',
    ]);
  });

  it('keeps a second picked in the language listened in, so it shows as picked', () => {
    expect(
      languageOptions(['de-AT', 'de-DE', 'en-US'], 'de-AT', nameOf, 'de-DE').map((o) => o.id),
    ).toEqual(['en-US', 'de-AT']);
  });

  it('leaves the language listened in out of the second language’s list', () => {
    expect(
      languageOptions(['en-US', 'en-GB', 'de-AT', 'de-DE'], AUTOMATIC, nameOf, 'en-US').map(
        (o) => o.id,
      ),
    ).toEqual(['de-AT', 'de-DE']);
  });
});

describe('secondLanguageNow', () => {
  it('is automatic’s language, the one picked, or none', () => {
    expect(secondLanguageNow(AUTOMATIC, 'de-AT', 'en-US')).toBe('de-AT');
    expect(secondLanguageNow(AUTOMATIC, undefined, 'en-US')).toBeUndefined();
    expect(secondLanguageNow('fr-FR', 'de-AT', 'en-US')).toBe('fr-FR');
    expect(secondLanguageNow(OFF, 'de-AT', 'en-US')).toBeUndefined();
  });

  it('is none when the one picked is the language listened in', () => {
    expect(secondLanguageNow('en-GB', 'de-AT', 'en-US')).toBeUndefined();
  });
});

describe('secondAfter', () => {
  it('turns a second in the new language back to Automatic, and leaves any other', () => {
    expect(secondAfter('de-AT', 'de-DE')).toBe(AUTOMATIC);
    expect(secondAfter('de-AT', 'en-US')).toBe('de-AT');
    expect(secondAfter(OFF, 'de-DE')).toBe(OFF);
    expect(secondAfter('de-AT', AUTOMATIC)).toBe('de-AT');
  });
});
