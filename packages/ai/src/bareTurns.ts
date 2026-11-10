import { foldSearchText } from '@calendar/core';
import { readExtras } from './extras.ts';
import {
  defersDate,
  durationMinutesOf,
  groundDate,
  isAllDayPhrase,
  isRenamePhrase,
  mentionsDate,
  namedWeekdays,
  periodOf,
  saysOnlyWhen,
  statedRepeat,
  statedTimes,
} from './grounding.ts';
import { mentionsInvitees } from './invitees.ts';
import type { QuickAddPrefill } from './normalizeQuickAdd.ts';

/**
 * A turn that is one bare phrase leaning on the draft: only where its
 * place is ("it's in Vienna", "the one in Berlin", "es ist in Wien"), or
 * only who it is with ("with Stefan", "mit Anna"). A model asked for the
 * whole event back answers such a turn its own way each time — Apple's
 * put "Vienna" over "Cafe Meek" or changed nothing, and wrote "with
 * Stefan" into the location — so the code reads these words alone and no
 * model is asked. Where says more of the place the draft has ("Cafe
 * Meek, Vienna", which the place lookup reads as a name and where it
 * is); company joins the title, as in a first phrase, and invites no one.
 *
 * Bare means bare: a turn with a second clause, a when, a verb, a hedge
 * or a word of the lists below says more than the phrase, and is the
 * model's to read, as before.
 */

/** What the thread knows of a draft beyond its prefill. */
export interface TurnContext {
  /**
   * The draft's place as the words said it, where a lookup or a pick
   * wrote the location over it ("Hard Rock Cafe" for "Hard Rock Cafe,
   * Rotenturmstraße 25, 1010 Vienna, Austria").
   */
  readonly placeSaid?: string | undefined;
  /** The words that made or changed this draft before this turn, oldest first. */
  readonly said?: ReadonlyArray<string> | undefined;
}

/** Lower-case, accent-free text with straight apostrophes and "ss" for ß. */
const fold = (text: string): string =>
  foldSearchText(text)
    .replaceAll(/[‘’`]/g, "'")
    .replaceAll('ß', 'ss');

/** A word as said, and folded without the punctuation around it. */
interface Word {
  readonly plain: string;
  readonly text: string;
}

const EDGES = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const HAS_LETTER = /[\p{L}\p{N}]/u;

/** The words of a turn. A sign on its own ("&", "+", "/") stays one: it joins or parts what is around it. */
const wordsOf = (utterance: string): ReadonlyArray<Word> =>
  utterance
    .trim()
    .split(/\s+/u)
    .filter((text) => text !== '')
    .map((text) => {
      const plain = fold(text).replaceAll(EDGES, '');
      return { plain: plain === '' ? text : plain, text };
    });

/** A word as written, capitals and umlauts kept, without the punctuation around it. */
const written = ({ text }: Word): string => text.replaceAll(EDGES, '');

/** The words as said, without the quotes and the punctuation a sentence puts around them. */
const textOf = (words: ReadonlyArray<Word>): string =>
  words
    .map(({ text }) => text)
    .join(' ')
    .replaceAll(/^[\s"'“”‘’„«»(]+|[\s"'“”‘’«».,;:!?…)]+$/gu, '');

const listed = (words: string): ReadonlySet<string> => new Set(words.split(/\s+/u));

/** Word sequences, the longest first, so "it is located" is read before "it is". */
const sequences = (...phrases: ReadonlyArray<string>): ReadonlyArray<ReadonlyArray<string>> =>
  phrases.map((phrase) => phrase.split(' ')).sort((a, b) => b.length - a.length);

/** How many words the longest of `among` that stands at `at` takes; 0 for none. */
const lengthAt = (
  words: ReadonlyArray<Word>,
  at: number,
  among: ReadonlyArray<ReadonlyArray<string>>,
): number =>
  among.find((sequence) => sequence.every((word, index) => words[at + index]?.plain === word))
    ?.length ?? 0;

/** How many words the longest of `among` that ends the words takes, a word before it left; 0 for none. */
const lengthAtEnd = (
  words: ReadonlyArray<Word>,
  among: ReadonlyArray<ReadonlyArray<string>>,
): number =>
  among.find(
    (sequence) =>
      sequence.length < words.length &&
      sequence.every(
        (word, index) => words[words.length - sequence.length + index]?.plain === word,
      ),
  )?.length ?? 0;

/** A word a correction opens with ("no, in Vienna", "sorry, the one in Berlin"). */
const OPENERS = sequences('no', 'nope', 'nein', 'actually', 'sorry', 'eigentlich');

/** Said at the end to be polite, nothing of the change ("in Vienna please"). */
const POLITE = sequences('please', 'bitte', 'thanks', 'thank you', 'danke');

/** Said at the end of what comes on top of what is there ("with Anna too", "mit Tom auch"). */
const ALSO = sequences('too', 'also', 'auch', 'as well');

/**
 * The words without what a turn ends in to be polite or in passing, and
 * whether that said "too": then the turn adds, whatever it opened with
 * ("actually, with Anna too" corrects nothing).
 */
const withoutFillers = (
  said: ReadonlyArray<Word>,
): { readonly adds: boolean; readonly words: ReadonlyArray<Word> } => {
  let words = said;
  let adds = false;
  for (;;) {
    const also = lengthAtEnd(words, ALSO);
    const drop = also > 0 ? also : lengthAtEnd(words, POLITE);
    if (drop === 0) {
      return { adds, words };
    }
    adds ||= also > 0;
    words = words.slice(0, words.length - drop);
  }
};

/** "The one …": one of several places of the name, told apart by where it is. */
const SELECTORS = sequences(
  'the one',
  'i mean the one',
  'i meant the one',
  "it's the one",
  "that's the one",
  'ich meine das',
  'ich meine den',
  'ich meine die',
  'ich meine der',
  'das',
  'der',
  'die',
  'den',
);

/** What leads from "the one" into where it is. */
const SELECTOR_LINKS = sequences(
  'in',
  'on',
  'at',
  'near',
  'by',
  'next to',
  'close to',
  'im',
  'am',
  'bei',
  'beim',
  'an',
  'auf',
  'neben',
  'nahe',
);

/** "It's in …": the place the draft has, said to be somewhere. */
const FRAMES = sequences(
  "it's",
  'its',
  'it is',
  'is',
  "that's",
  'thats',
  'that is',
  "it's located",
  'it is located',
  'es ist',
  'das ist',
  'es liegt',
  'liegt',
  'ist',
);

/** What stands before a place or a person and is not its name ("the airport", "my parents", "her husband"). */
const DETERMINERS = listed(
  `a an her his my our the their your
   das dem den der die einem einer deinem deiner ihrem ihrer meinem meiner seinem seiner
   unserem unserer`,
);

/**
 * Words with which a turn says more than a bare phrase, wherever they
 * stand after its "in" or "with": a verb that asks for another change
 * ("… and make it 8"), an adverb that moves or sizes the event, a hedge
 * ("in Vienna I think", "vielleicht"), a word that turns the phrase
 * around or addresses other drafts ("both"), a place taken away.
 */
const SAYS_MORE = listed(
  `add call cancel change delete make move name put rename set
   andere entferne lade losche nenn nenne setze verschiebe
   again earlier later longer shorter only nochmal
   actually i maybe mean now obviously perhaps probably think though
   denke eigentlich glaube ich naturlich vielleicht wahrscheinlich wohl
   busy free tentative all both alle beide
   but instead not no without aber statt stattdessen nicht kein keine keinen ohne`,
);

/**
 * German words that say more only as written here: "länger" sizes the
 * event and Frau Langer is company, "lieber" turns the phrase around and
 * Herr Lieber does not.
 */
const SAYS_MORE_AS_WRITTEN = listed('doch früher kürzer lieber länger mach mache später');

/**
 * Words no city's, district's or person's name is made of here: with one
 * of them the words say more than where or who ("in front of the opera",
 * "in honor of Anna", "with Anna from accounting").
 */
const NOT_OF_A_NAME = listed(
  `a an and as at by for from her his is it my of or our that the their these this those to
   with your als bei das dem den der des die ein eine einem einer eines es fur ist mit oder
   und von zu`,
);

/** An app an event is held in — no place it is at, wherever the name stands ("in Google Meet"), and no company. */
const APP_NAMES = 'discord facetime hangouts meet skype slack teams webex zoom';
const APPS = listed(APP_NAMES);

/**
 * What follows "in", or "the one" and its link, and is no place when it
 * is all there is: how it is held ("in person", "in Präsenz", "in
 * English", "in groups"), a state or a saying ("in Ordnung", "in
 * progress", "in Urlaub"), a colour, a season or another when the
 * when-readers do not know ("the one on the weekend", "in Easter week"),
 * and where the speaker is ("the one near me", "das in der Nähe"). German
 * writes every noun with a capital and a typed turn often none, so the
 * letters do not tell a name: this list does. A name that only begins
 * with such a word is a name ("Orange County", "Home Depot", "Easter
 * Road").
 */
const NOT_A_PLACE = listed(
  `addition advance bed between brief bulk case cash character charge church class common
   conclusion costume court detail doubt effect essence fact full general groups half hand
   house ink kind line love mind order pairs parallel particular pencil person place play
   practice principle private progress public question reverse school secret session shifts
   short silence stereo stock store sum sync theory tie time total touch town transit trouble
   turn uniform use vain view writing
   arabic chinese croatian czech danish dutch english finnish french german greek hebrew
   hindi hungarian italian japanese korean norwegian polish portuguese russian serbian
   spanish swedish turkish deutsch englisch franzosisch italienisch spanisch
   black blue brown color colour gray green grey orange pink purple red white yellow
   blau gelb grun rot schwarz weiss
   autumn fall spring summer winter fruhling herbst sommer future zukunft
   anniversary birthday christmas day easter holiday holidays month week weekend year
   feiertag ferien geburtstag jahr monat ostern tag weihnachten woche wochenende
   here home me mine nearby ours there us work hause hier dort mir nahe uns zuhause
   absprache abstimmung abwesenheit anwesenheit arbeit bearbeitung begleitung echt eile
   elternzeit farbe frage gedanken gesellschaft gruppen karenz kopie kurze ordnung planung
   prasenz quarantane raten rente ruhe sicht summe teilzeit urlaub vertretung vollzeit
   vorbereitung wahrheit wirklichkeit zivil`,
);

/** Words of a where at most: "Stratford upon Avon", "the one on Mariahilfer Straße". */
const WHERE_WORDS = 4;

const DIGIT = /\p{N}/u;

/** Letters all in capitals name something ("the US"), whatever the word is in small ones. */
const ACRONYM = /^\p{Lu}{2,}$/u;

/** Short forms whose period ends no sentence ("St. Pölten", "Dr. Huber"). */
const ABBREVIATIONS = listed('dr fr hr jr mr mrs ms prof sr st');

/** Whether a word ends a clause: a period, a semicolon, a colon after it ("Vienna. Anna too"). */
const endsClause = (word: Word): boolean =>
  /[.;:!?]["'”’)]*$/u.test(word.text) && !ABBREVIATIONS.has(word.plain);

/** Whether a clause ends, or a comma stands, before the words are over. */
const hasBreak = (words: ReadonlyArray<Word>, { commas }: { readonly commas: boolean }): boolean =>
  words.slice(0, -1).some((word) => endsClause(word) || (commas && word.text.includes(',')));

/** Whether a word, or a part of a hyphenated one ("E-Mail-Erinnerung"), is on the list. */
const among = ({ plain }: Word, list: ReadonlySet<string>): boolean =>
  list.has(plain) || plain.split('-').some((part) => list.has(part));

/**
 * Whether the words say anything of when: a day, a time, a length, a
 * repeat. "The one on Friday" picks a day and "in March" a month, never
 * a place.
 */
const saysWhen = (utterance: string, rest: string): boolean =>
  saysOnlyWhen(rest) ||
  namedWeekdays(utterance).length > 0 ||
  // Any day will do to hear "tomorrow" or "heute": only whether one is named counts.
  groundDate(undefined, { phrase: utterance, referenceDate: '2026-01-01' }) !== undefined ||
  mentionsDate(utterance) ||
  defersDate(utterance) ||
  periodOf(utterance) !== undefined ||
  statedTimes(utterance).start !== undefined ||
  durationMinutesOf(utterance) !== undefined ||
  isAllDayPhrase(utterance) ||
  statedRepeat(utterance) !== undefined;

/**
 * Whether the turn says more than the bare phrase: guests invited or
 * taken off, a rename, a when, or a word of `SAYS_MORE` among the words
 * the phrase leads into. Such a turn is the model's to read whole, with
 * the people question beside it.
 */
const saysMore = (utterance: string, words: ReadonlyArray<Word>, phrase: string): boolean =>
  mentionsInvitees(utterance) ||
  isRenamePhrase(utterance) ||
  words.some((word) => among(word, SAYS_MORE) || SAYS_MORE_AS_WRITTEN.has(written(word))) ||
  saysWhen(utterance, phrase);

/** Whether a word is one that is no place, small letters or not; "US" is one. */
const isNoPlace = (word: Word): boolean => among(word, NOT_A_PLACE) && !ACRONYM.test(written(word));

/**
 * Whether the words name a place and nothing else: a few words in one
 * clause, none of them a function word, a sign or an app, the first no
 * number, and not all of them words that are no place.
 */
const namesWhere = (name: ReadonlyArray<Word>): boolean => {
  const [first] = name;
  return (
    first !== undefined &&
    name.length <= WHERE_WORDS &&
    !DIGIT.test(first.plain) &&
    !hasBreak(name, { commas: true }) &&
    name.every(
      (word) => HAS_LETTER.test(word.plain) && !NOT_OF_A_NAME.has(word.plain) && !among(word, APPS),
    ) &&
    !name.every(isNoPlace)
  );
};

/** Where a turn says the draft's place is, and whether it says so as a correction ("no, in Graz"). */
interface Where {
  readonly corrects: boolean;
  readonly where: string;
}

const readWhere = (utterance: string): Where | undefined => {
  const { adds, words } = withoutFillers(wordsOf(utterance));
  const from = lengthAt(words, 0, OPENERS);
  const selector = lengthAt(words, from, SELECTORS);
  const link = selector === 0 ? 0 : lengthAt(words, from + selector, SELECTOR_LINKS);
  let name: ReadonlyArray<Word>;
  if (link > 0) {
    const rest = words.slice(from + selector + link);
    name = rest[0] !== undefined && DETERMINERS.has(rest[0].plain) ? rest.slice(1) : rest;
  } else {
    const at = from + lengthAt(words, from, FRAMES);
    if (words[at]?.plain !== 'in') {
      return undefined;
    }
    name = words.slice(at + 1);
    // A bare name has no number: "in 2 hours" and "in Room 4" say other things.
    if (name.some(({ plain }) => DIGIT.test(plain))) {
      return undefined;
    }
  }
  const where = textOf(name);
  return namesWhere(name) && where !== '' && !saysMore(utterance, name, where)
    ? { corrects: from > 0 && !adds, where }
    : undefined;
};

/**
 * Where a turn says the draft's place is, when that is all it says: "the
 * one" and what leads to where ("the one in Berlin", "the one on
 * Mariahilfer Straße", "das beim Bahnhof"), or "in" and a bare name with
 * or without "it's" before it ("it's in Vienna", "in Neubau", "es ist in
 * Wien"). "In the office" and "im Büro" name a venue of their own, "at
 * Café Central" another place, "in Vienna instead" a replacement, "in
 * Vienna, invite Anna" and "In Vienna. Anna too." two things: those are
 * the model's to read, as before.
 */
export const whereOf = (utterance: string): string | undefined => readWhere(utterance)?.where;

/** What "with" leads into that is no company: a notification, a note, a call's link, a title. */
const NOT_COMPANY = listed(
  `${APP_NAMES}
   alarm alarms alert alerts conference conferencing email link mail meeting note notes
   notification notifications pleasure push reminder reminders title video
   benachrichtigung benachrichtigungen erinnerung erinnerungen hinweis notiz notizen titel
   wecker`,
);

/** Words after which the turn says more than who: a place, a time. */
const ENDS_COMPANY = listed('am at bei beim dann im in on then to um');

/** What a company turn may open with ("and with Stefan", "auch mit Anna"). */
const COMPANY_FRAMES = sequences("it's", 'its', 'it is', 'and', 'also', 'es ist', 'und', 'auch');

/** What joins the people of a company. */
const JOINS = listed('and und &');

/** People in a company at most, and words in a person's name ("the design team", "Anna Lee"). */
const COMPANY_PEOPLE = 3;
const PERSON_WORDS = 2;

/** Who a turn says the event is with. */
export interface Company {
  /** Said as a correction ("no, with Anna"): in place of the company the title has. */
  readonly corrects: boolean;
  /** The linking word as the title takes it. */
  readonly link: 'mit' | 'with';
  /** The people as said, one by one ("Stefan", "the team"). */
  readonly people: ReadonlyArray<string>;
}

/** Whether the words are one person: a determiner at most and a word or two, none of the lists. */
const isPerson = (person: ReadonlyArray<Word>): boolean => {
  const name =
    person[0] !== undefined && DETERMINERS.has(person[0].plain) ? person.slice(1) : person;
  return (
    name.length > 0 &&
    name.length <= PERSON_WORDS &&
    name.every(
      (word) =>
        HAS_LETTER.test(word.plain) &&
        !DIGIT.test(word.plain) &&
        !NOT_OF_A_NAME.has(word.plain) &&
        !ENDS_COMPANY.has(word.plain) &&
        !among(word, NOT_COMPANY),
    )
  );
};

/**
 * The people a company names, one by one, or undefined for anything
 * else. "And" joins them, and a comma where an "and" follows it ("Tom,
 * Anna and Stefan"): a comma alone parts two clauses ("with Stefan,
 * tentative").
 */
const peopleOf = (rest: ReadonlyArray<Word>): ReadonlyArray<string> | undefined => {
  if (hasBreak(rest, { commas: false })) {
    return undefined;
  }
  const people: Array<Array<Word>> = [[]];
  let closed = true;
  for (const [index, word] of rest.entries()) {
    if (JOINS.has(word.plain)) {
      people.push([]);
      closed = true;
      continue;
    }
    people.at(-1)!.push(word);
    if (index < rest.length - 1 && word.text.includes(',')) {
      people.push([]);
      closed = false;
    }
  }
  return closed && people.length <= COMPANY_PEOPLE && people.every(isPerson)
    ? people.map(textOf)
    : undefined;
};

/**
 * Who a turn says the event is with, when that is all it says ("with
 * Stefan", "with the team", "mit Anna und Tom", "no, with Anna"):
 * people joined by "and", each a word or two.
 */
export const companyOf = (utterance: string): Company | undefined => {
  const { adds, words } = withoutFillers(wordsOf(utterance));
  const from = lengthAt(words, 0, OPENERS);
  const at = from + lengthAt(words, from, COMPANY_FRAMES);
  const link = words[at]?.plain;
  if (link !== 'with' && link !== 'mit') {
    return undefined;
  }
  const rest = words.slice(at + 1);
  const people = peopleOf(rest);
  return people !== undefined && !saysMore(utterance, rest, textOf(rest))
    ? { corrects: from > 0 && !adds, link, people }
    : undefined;
};

const lettersOf = (text: string): ReadonlyArray<string> =>
  fold(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');

/** Whether `text` holds every word of `words` as a word of its own. */
const holdsWords = (text: string, words: string): boolean => {
  const held = new Set(lettersOf(text));
  const wanted = lettersOf(words);
  return wanted.length > 0 && wanted.every((word) => held.has(word));
};

/**
 * Whether the place says that where already: one of its parts between
 * commas is that where, a postal code aside ("Cafe Meek, Vienna", "…,
 * 1010 Vienna, Austria", "Vienna" itself). A name that holds its city
 * says nothing ("Vienna Cafe" may stand in Graz), and a word of a part is
 * not the part ("York" of "New York").
 */
const saysAlready = (place: string, where: string): boolean => {
  const wanted = lettersOf(where).join(' ');
  return place.split(',').some(
    (part) =>
      lettersOf(part)
        .filter((word) => !DIGIT.test(word))
        .join(' ') === wanted,
  );
};

/**
 * An earlier turn as the refine step read it: without the note or the
 * notifications said with it ("it's in Vienna, remind me 10 minutes
 * before").
 */
const changeOf = (earlier: string): string => readExtras(earlier).rest;

/**
 * The place without the where an earlier bare turn gave it: a second
 * "it's in …" takes the first one's place. Nothing is left of a place
 * such a turn set alone ("in Berlin" on a draft without one).
 */
const withoutEarlierWhere = (place: string, said: ReadonlyArray<string>): string => {
  for (const earlier of [...said].reverse()) {
    const where = whereOf(changeOf(earlier));
    if (where === undefined || where.length > place.length) {
      continue;
    }
    const lead = place.slice(0, place.length - where.length);
    if (fold(place.slice(lead.length)) !== fold(where)) {
      continue;
    }
    if (lead.trim() === '') {
      return '';
    }
    if (/,\s*$/u.test(lead)) {
      return lead.replace(/,\s*$/u, '');
    }
  }
  return place;
};

/** A place said with where it is after a comma ("Cafe Meek, Vienna, Austria"): the place alone. */
const withoutSaidWhere = (place: string): string => {
  const [first = '', ...rest] = place.split(',');
  return rest.length > 0 && first.trim() !== '' ? first.trim() : place;
};

/**
 * The draft's location once a turn said where its place is: the where
 * alone for a draft without a place; nothing new where the location or
 * the place as said says so already (`saysAlready`); else the place as
 * said and the where after it — in place of the where an earlier bare
 * turn gave it, or, said as a correction, of the one the place was said
 * with.
 */
const narrowed = (
  { corrects, where }: Where,
  location: string | undefined,
  { placeSaid, said = [] }: TurnContext,
): string => {
  const whole = location?.trim() ?? '';
  if (whole === '') {
    return where;
  }
  const asSaid = placeSaid?.trim() || whole;
  if (saysAlready(whole, where) || saysAlready(asSaid, where)) {
    return whole;
  }
  const earlier = withoutEarlierWhere(asSaid, said);
  const base = corrects && earlier === asSaid ? withoutSaidWhere(asSaid) : earlier;
  return base === '' ? where : `${base}, ${where}`;
};

/** A title that ends in its company: what comes before, the linking word, the company. */
const COMPANY_IN_TITLE = /^(.*\S)\s+(with|mit|w\/)\s+(\S.*)$/iu;

/** The word that joins people after a linking word: the title's language, not the turn's. */
const andAfter = (link: string): string => (fold(link) === 'mit' ? ' und ' : ' and ');

/** Where the person stands among the people: by the words the two names begin with ("Stefan", "Stefan Huber"). */
const indexOfPerson = (people: ReadonlyArray<string>, person: string): number => {
  const words = lettersOf(person);
  return people.findIndex((each) => {
    const held = lettersOf(each);
    const shared = Math.min(held.length, words.length);
    return shared > 0 && held.slice(0, shared).join(' ') === words.slice(0, shared).join(' ');
  });
};

/**
 * The title with the company a turn named. A title without company
 * takes the people it does not hold, after the turn's "with". One that
 * ends in its company takes them into it — a fuller name in place of the
 * shorter ("Stefan Huber" for "Stefan"), joined in the title's language —
 * or, said as a correction, gives the old company up for them. Undefined
 * for a draft without a title, and where more than company follows the
 * title's "with" ("Call with Stefan about the budget"): the model reads
 * those turns.
 */
const withCompany = (title: string, { corrects, link, people }: Company): string | undefined => {
  if (title.trim() === '') {
    return undefined;
  }
  const had = COMPANY_IN_TITLE.exec(title);
  if (had === null) {
    const fresh = people.filter((person) => !holdsWords(title, person));
    return fresh.length === 0 ? title : `${title} ${link} ${fresh.join(andAfter(link))}`;
  }
  const [, lead = '', word = link, tail = ''] = had;
  const known = peopleOf(wordsOf(tail));
  if (known === undefined) {
    return undefined;
  }
  const next = corrects ? [] : [...known];
  for (const person of people) {
    const at = indexOfPerson(next, person);
    if (at === -1) {
      next.push(person);
    } else if (lettersOf(person).length > lettersOf(next[at]!).length) {
      next[at] = person;
    }
  }
  const same = next.length === known.length && next.every((person, at) => person === known[at]);
  return same ? title : `${lead} ${word} ${next.join(andAfter(word))}`;
};

/**
 * The draft as a bare turn leaves it, or undefined for any other turn.
 * A to-do has no place (`places: false`): what its words say of one is
 * the model's to read into its title, as before.
 */
export const bareTurn = (
  utterance: string,
  draft: QuickAddPrefill,
  { places = true, ...context }: TurnContext & { readonly places?: boolean | undefined } = {},
): QuickAddPrefill | undefined => {
  const where = places ? readWhere(utterance) : undefined;
  if (where !== undefined) {
    const location = narrowed(where, draft.location, context);
    return location === draft.location ? draft : { ...draft, location };
  }
  const company = companyOf(utterance);
  const title = company === undefined ? undefined : withCompany(draft.title, company);
  if (title === undefined) {
    return undefined;
  }
  return title === draft.title ? draft : { ...draft, title };
};
