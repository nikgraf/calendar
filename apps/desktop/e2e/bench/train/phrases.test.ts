import { fileURLToPath } from 'node:url';
import { Temporal } from '@calendar/core';
import { describe, expect, it } from 'vite-plus/test';
import { loadCases, loadContacts } from '../cases.ts';
import { fold } from '../check.ts';
import {
  bookOf,
  BRIEF_EXAMPLES,
  BRIEFS,
  buildGeneratorPrompt,
  FIRST_ROUND_BRIEFS,
  type Names,
  namesOf,
  nearBench,
  referenceDateOf,
  repeatsBriefExample,
  threadsOf,
} from './phrases.ts';

// Names as the generator would write them; the tests only need a few.
const NAMES: Names = {
  people: [
    ['Ada', 'Lindgren'],
    ['Bram', 'Okonkwo'],
    ['Cleo', 'Hartl'],
    ['Dario', 'Ferreira'],
    ['Esme', 'Wójcik'],
    ['Fenna', 'Brugger'],
    ['Goran', 'Ilić'],
    ['Hira', 'Qureshi'],
    ['Ines', 'Navarro'],
  ],
  places: [
    'Café Roth',
    'room 3.02',
    'Stadtpark',
    'the Lantern Bar',
    'Praxis Dr. Weiss',
    'Graz',
    'Pier 12',
  ],
};

const benchPhrases = loadCases(fileURLToPath(new URL('../cases', import.meta.url))).flatMap(
  (benchCase) =>
    benchCase.turns.map((turn) => ('text' in turn.input ? turn.input.text : turn.input.transcript)),
);

describe('the generator briefs', () => {
  it('cover every language, way of writing and focus once', () => {
    expect(BRIEFS).toHaveLength(2 * 5 * 16);
    expect(new Set(BRIEFS.map((brief) => JSON.stringify(brief))).size).toBe(BRIEFS.length);
  });

  it('keep the first round’s briefs where they were, the later focuses after them', () => {
    // A brief's place is its seed and the place of its threads: it must not move.
    expect(FIRST_ROUND_BRIEFS).toBe(140);
    expect(BRIEFS[0]).toEqual({ focus: 'allDay', language: 'en', register: 'command' });
    expect(BRIEFS[139]).toEqual({ focus: 'short', language: 'de', register: 'todo' });
    const later = new Set(BRIEFS.slice(FIRST_ROUND_BRIEFS).map((brief) => brief.focus));
    expect([...later].sort()).toEqual(['farDays', 'ruledOut']);
    expect(BRIEFS.slice(0, FIRST_ROUND_BRIEFS).filter((brief) => later.has(brief.focus))).toEqual(
      [],
    );
  });

  it('show the generator no phrase of the bench', () => {
    const prompts = BRIEFS.map((brief, index) =>
      fold(buildGeneratorPrompt(brief, index, 30, NAMES)),
    );
    // One word is no phrase ("tomorrow"); two and more would be a case given away.
    const phrases = benchPhrases.map(fold).filter((phrase) => phrase.split(' ').length > 1);
    const shown = phrases.filter((phrase) => prompts.some((prompt) => prompt.includes(phrase)));
    expect(shown).toEqual([]);
  });

  it('ask for the count, the language and the same names on every run', () => {
    const german = BRIEFS.findIndex((brief) => brief.language === 'de');
    const prompt = buildGeneratorPrompt(BRIEFS[german]!, german, 12, NAMES);
    expect(prompt).toContain('Write 12 threads.');
    expect(prompt).toContain('Language: German');
    expect(buildGeneratorPrompt(BRIEFS[german]!, german, 12, NAMES)).toBe(prompt);
    expect(buildGeneratorPrompt(BRIEFS[0]!, 0, 12, NAMES)).not.toBe(
      buildGeneratorPrompt(BRIEFS[0]!, 1, 12, NAMES),
    );
  });
});

describe('the names', () => {
  const books = loadContacts(fileURLToPath(new URL('../contacts.json', import.meta.url)));
  const benchBook = Object.values(books).flat();

  it('keep no one the bench’s books hold, by name or address, and no one twice', () => {
    const [someone] = benchBook;
    const [first = '', ...rest] = (someone?.displayName ?? 'Tom Baker').split(' ');
    const written = namesOf(
      {
        people: [
          { first: 'Ada', last: 'Lindgren' },
          { first: ' ada ', last: 'LINDGREN' },
          { first, last: rest.join(' ') },
          { first: 'Bram', last: '' },
          'nobody',
        ],
        places: ['Café Roth', 'café roth', ' ', 'Graz'],
      },
      benchBook,
    );
    expect(written).toEqual({ people: [['Ada', 'Lindgren']], places: ['Café Roth', 'Graz'] });
  });

  it('make an address book at made-up addresses', () => {
    const book = bookOf(NAMES.people);
    expect(book.map((contact) => contact.email)).toContain('esme.wjcik@example.com');
    expect(book.every((contact) => contact.email.endsWith('@example.com'))).toBe(true);
    expect(new Set(book.map((contact) => contact.id)).size).toBe(book.length);
  });
});

describe('the briefs’ examples', () => {
  it('are the quoted phrases of two words or more', () => {
    expect(BRIEF_EXAMPLES).toContain('haircut wed 4pm');
    expect(BRIEF_EXAMPLES.some((example) => example.includes('…'))).toBe(false);
  });

  it('mark a phrase that repeats one word for word, and only such a phrase', () => {
    expect(repeatsBriefExample('Haircut Wed 4pm')).toBe(true);
    expect(repeatsBriefExample('haircut wed 4pm at the salon')).toBe(true);
    expect(repeatsBriefExample('haircut thursday 4pm')).toBe(false);
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
