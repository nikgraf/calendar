import { fileURLToPath } from 'node:url';
import { Temporal } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import { loadCases, loadContacts } from '../cases.ts';
import { fold } from '../check.ts';
import {
  BRIEFS,
  buildGeneratorPrompt,
  nearBench,
  referenceDateOf,
  threadsOf,
  trainingBook,
} from './phrases.ts';

const benchPhrases = loadCases(fileURLToPath(new URL('../cases', import.meta.url))).flatMap(
  (benchCase) =>
    benchCase.turns.map((turn) => ('text' in turn.input ? turn.input.text : turn.input.transcript)),
);

describe('the generator briefs', () => {
  it('cover every language, way of writing and focus once', () => {
    expect(BRIEFS).toHaveLength(2 * 5 * 14);
    expect(new Set(BRIEFS.map((brief) => JSON.stringify(brief))).size).toBe(BRIEFS.length);
  });

  it('show the generator no phrase of the bench', () => {
    const prompts = BRIEFS.map((brief, index) => fold(buildGeneratorPrompt(brief, index, 30)));
    // One word is no phrase ("tomorrow"); two and more would be a case given away.
    const phrases = benchPhrases.map(fold).filter((phrase) => phrase.split(' ').length > 1);
    const shown = phrases.filter((phrase) => prompts.some((prompt) => prompt.includes(phrase)));
    expect(shown).toEqual([]);
  });

  it('ask for the count, the language and the same names on every run', () => {
    const german = BRIEFS.findIndex((brief) => brief.language === 'de');
    const prompt = buildGeneratorPrompt(BRIEFS[german]!, german, 12);
    expect(prompt).toContain('Write 12 threads.');
    expect(prompt).toContain('Language: German');
    expect(buildGeneratorPrompt(BRIEFS[german]!, german, 12)).toBe(prompt);
    expect(buildGeneratorPrompt(BRIEFS[0]!, 0, 12)).not.toBe(
      buildGeneratorPrompt(BRIEFS[0]!, 1, 12),
    );
  });
});

describe('the training address book', () => {
  it('shares no one with the bench’s books', () => {
    const books = loadContacts(fileURLToPath(new URL('../contacts.json', import.meta.url)));
    const theirs = Object.values(books).flat();
    const emails = new Set(theirs.map((contact) => contact.email));
    const names = new Set(theirs.map((contact) => fold(contact.displayName ?? '')));
    expect(trainingBook.filter((contact) => emails.has(contact.email))).toEqual([]);
    expect(trainingBook.filter((contact) => names.has(fold(contact.displayName ?? '')))).toEqual(
      [],
    );
    expect(trainingBook.every((contact) => contact.email.endsWith('@example.com'))).toBe(true);
  });
});

describe('threadsOf', () => {
  it('takes one to three phrases a thread, trimmed, and drops what is none', () => {
    expect(
      threadsOf({
        threads: [
          { turns: ['  haircut   wed 4pm ', 'at 5 instead'] },
          { turns: [] },
          { turns: ['a', '', 'b', 'c', 'd'] },
          { turns: 'no list' },
          'no thread',
          { turns: [7, 'swim'] },
        ],
      }),
    ).toEqual([['haircut wed 4pm', 'at 5 instead'], ['a', 'b', 'c'], ['swim']]);
  });

  it('is empty for an answer that is no list of threads', () => {
    expect(threadsOf(undefined)).toEqual([]);
    expect(threadsOf({ threads: 'none' })).toEqual([]);
  });
});

describe('nearBench', () => {
  it('finds a phrase of the bench, however it is cased or spaced', () => {
    expect(nearBench('dentist  THURSDAY at 10', ['Dentist Thursday at 10'])).toBe(true);
  });

  it('finds one that shares four fifths of its words', () => {
    expect(
      nearBench('Lunch with Tom tomorrow at 1 note: bring the contract please', [
        'Lunch with Tom tomorrow at 1, note: bring the contract',
      ]),
    ).toBe(true);
  });

  it('finds a bench phrase of three words said whole inside a longer one', () => {
    expect(nearBench('actually make it 8', ['make it 8'])).toBe(true);
    expect(nearBench('so the dentist is thursday at 10 I think', ['Dentist Thursday at 10'])).toBe(
      true,
    );
    // Two words are too few to give a case away.
    expect(nearBench('swimming every week with Carla', ['every week'])).toBe(false);
  });

  it('lets a phrase of its own through, a short follow-up of the same kind too', () => {
    expect(nearBench('Haircut Wednesday at 4', ['Dentist Thursday at 10'])).toBe(false);
    expect(nearBench('make it 9', ['make it 8'])).toBe(false);
  });

  it('counts words that are nothing as a phrase to leave out', () => {
    expect(nearBench(' … ', [])).toBe(true);
  });
});

describe('referenceDateOf', () => {
  it('gives real days, spread over the weekdays', () => {
    const days = Array.from({ length: 70 }, (_, index) => referenceDateOf(index));
    const weekdays = new Set(days.map((day) => Temporal.PlainDate.from(day).dayOfWeek));
    expect(weekdays.size).toBe(7);
    expect(new Set(days).size).toBe(70);
    expect(referenceDateOf(3)).toBe(referenceDateOf(3));
  });
});
