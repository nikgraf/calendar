import { foldSearchText } from '@calendar/core';
import type { LanguageModel } from './model.ts';
import { meaningfulText } from './shared.ts';

/**
 * Who a phrase invites, read against its words. The model names the
 * people in a question of its own (`readPeople`), asked beside the
 * quick-add or refine prompt and only when the words hold a cue: those
 * prompts stay as they were (in a refinement, Apple's model named no one
 * and wrote the guest into the title instead). The code keeps a name only
 * in the guest list of an invitation cue — "invite Tom and Anna", "add
 * Anna as a guest", "send an invite to Tom", "lade Tom ein", "Tom und
 * Anna einladen" — and reads from the cue whether it invites or takes
 * off the guest list ("don't invite Tom", "remove Anna", "ohne Tom",
 * "Tom ausladen"). "Lunch with Sarah" names a person but invites no one:
 * an invitation emails them, so only the words that ask for one make
 * one, and where the code cannot read them it has no opinion.
 */

/** Lower-case, accent-free text with straight apostrophes and "ss" for ß. */
const fold = (text: string): string =>
  foldSearchText(text)
    .replaceAll(/[‘’`]/g, "'")
    .replaceAll('ß', 'ss');

export interface InviteeChange {
  /** Names or addresses the words invite, as the words spell them. */
  readonly invite: ReadonlyArray<string>;
  /** Names or addresses the words take off the guest list. */
  readonly uninvite: ReadonlyArray<string>;
}

type CueKind = 'invite' | 'uninvite';

interface Cue {
  readonly end: number;
  readonly kind: CueKind;
  /** `first`: the names follow ("invite Tom"); `final`: they come before ("Tom einladen"). */
  readonly order: 'final' | 'first';
  readonly start: number;
}

/** Cues whose names follow them. */
const FIRST_CUES: ReadonlyArray<readonly [CueKind, RegExp]> = [
  [
    'uninvite',
    /\b(?:uninvit(?:e|es|ed|ing)|disinvit(?:e|es|ed|ing)|remove|drop|without|ohne|entfern(?:e|en|t)?|streich(?:e|en|t)?)\b/g,
  ],
  [
    'invite',
    /\b(?:invit(?:e|es|ed|ing)|invitations?|einladung(?:en)?|add(?=\s[^.;!?]*\bas\s+(?:an?\s+)?(?:guests?|attendees?|invitees?)\b))\b/g,
  ],
];

/** Cues whose names come before them, German verb-final. */
const FINAL_CUES: ReadonlyArray<readonly [CueKind, RegExp]> = [
  ['uninvite', /\b(?:nicht\s+(?:ein(?:zu)?laden|einlade|eingeladen)|aus(?:zu)?laden|auslade)\b/g],
  ['invite', /\b(?:ein(?:zu)?laden|einlade|eingeladen)\b/g],
];

/** "lade Tom ein" / "lade Anna aus": the verb first, its particle after the names. */
const SPLIT_VERB = /\blad(?:e|t|en)?\b/g;
const PARTICLE = /\b(ein|aus)\b/;

/**
 * An invitation said not to happen ("do not add Tom as a guest", "never
 * invite Anna", "lade Tom nicht ein"): it takes the guest off instead.
 */
const NOT_BEFORE =
  /(?<!\bwhy\s)\b(?:don'?t|do not|does not|did not|not|no longer|never|nicht|nie)\s+$/;

/**
 * A negation earlier in a cue's clause that is not right before it
 * ("don't send an invite to Tom", "no invitation to Tom", "don't remove
 * Anna"): the code cannot tell what it rules out, so the cue says nothing.
 */
const NEGATION_IN_CLAUSE =
  /(?<!\bwhy\s)\b(?:don'?t|do not|does not|did not|not|never|no|nicht|nie|kein\w*)\b/;

/**
 * A noun, not a request — "the invitation from Tom" is something to talk
 * about — unless it says for whom: "an invite to Tom", "Einladung an Jörg".
 */
const NOUN_CUE = /^(?:invitations?|einladung(?:en)?)$/;
const DETERMINER_BEFORE =
  /\b(?:a|an|the|my|your|his|her|its|our|their|this|that|these|those|no)\s+$/;
const FOR_WHOM_AFTER = /^\s+(?:to|for|an|fur)\b/;

/** Words that name no one to look up: the user, a pronoun, everyone. */
const NOT_A_PERSON = new Set([
  'alle',
  'all',
  'everybody',
  'everyone',
  'her',
  'him',
  'i',
  'ihn',
  'ihr',
  'me',
  'mich',
  'mir',
  'myself',
  'sie',
  'them',
  'uns',
  'us',
]);

/**
 * What may stand between a cue and a name of its guest list besides the
 * other people (`PERSON`): a "to" or "for" right after the cue, then
 * separators and list words — "invite Tom, Anna and also Bob", "lade
 * auch Jörg ein", "Tom und Anna einladen". Anything else ("invite Tom to
 * lunch with Sarah", "but not", "and put bob@… in the description") ends
 * the list.
 */
const PERSON = '\u0001';
const LIST_WORDS =
  'and|und|or|oder|also|too|auch|noch|as well as|plus|sowie|please|bitte|both|beide|me|myself|us|mich|mir|uns';
const LIST_GAP = new RegExp(
  `^\\s*(?:(?:to|for|an|fur)\\s+)?(?:[\\s,&${PERSON}]|\\b(?:${LIST_WORDS})\\b)*$`,
);

/** A name right after "with": company, not a guest ("Essen mit Sarah, Tom einladen"). */
const COMPANY_BEFORE = /\b(?:with|mit)\s+$/;

/** A negation right before a name, for a cue after it ("Anna und nicht Tom einladen"). */
const NEGATED_BEFORE =
  /\b(?:not|except|excluding|instead of|rather than|nicht|ausser|ausgenommen|statt|anstatt|keine?[nm]?)\s+$/;

/**
 * An address, whole ("o'connor@example.com", not "connor@…"): read by the
 * code, since a model shortened "tom@example.com" to "Tom".
 */
const ADDRESS =
  /(?<![a-z0-9.!#$%&*+/=?^_`{|}~-])[a-z0-9][a-z0-9.!#$%&'*+/=?^_`{|}~-]*@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?![a-z0-9-])/g;

/** Where sentences end: a period only before a space or the end. */
const SENTENCE_END = /[;!?\n]|\.(?=\s|$)/g;

const boundsOf = (text: string, pattern: RegExp, at: number): readonly [number, number] => {
  let start = 0;
  let end = text.length;
  for (const match of text.matchAll(pattern)) {
    if (match.index < at) {
      start = match.index + match[0].length;
    } else {
      end = match.index;
      break;
    }
  }
  return [start, end];
};

const sentenceOf = (text: string, at: number) => boundsOf(text, SENTENCE_END, at);
const partOf = (text: string, at: number) => boundsOf(text, /[,;!?\n]|\.(?=\s|$)/g, at);

/** Where a name or an address stands in the words. */
interface Span {
  readonly at: number;
  readonly length: number;
}

/**
 * The folded words with every address blanked out, so what an address
 * holds ("alice@mit.edu", "invite@…") is never read as language, and
 * where the addresses were.
 */
const masked = (
  text: string,
): { readonly addresses: ReadonlyArray<Span>; readonly text: string } => {
  const addresses = [...text.matchAll(ADDRESS)].map((match) => ({
    at: match.index,
    length: match[0].length,
  }));
  let blanked = text;
  for (const { at, length } of addresses) {
    blanked = `${blanked.slice(0, at)}${'#'.repeat(length)}${blanked.slice(at + length)}`;
  }
  return { addresses, text: blanked };
};

const cuesIn = (text: string): ReadonlyArray<Cue> => {
  const cues: Array<Cue> = [];
  const taken = (start: number, end: number) =>
    cues.some((cue) => start < cue.end && cue.start < end);
  const negatedClause = (at: number) =>
    NEGATION_IN_CLAUSE.test(text.slice(partOf(text, at)[0], at));
  for (const [order, list] of [
    ['first', FIRST_CUES],
    ['final', FINAL_CUES],
  ] as const) {
    for (const [kind, pattern] of list) {
      for (const match of text.matchAll(pattern)) {
        const end = match.index + match[0].length;
        if (taken(match.index, end)) {
          continue;
        }
        const before = text.slice(0, match.index);
        if (
          kind === 'invite' &&
          order === 'first' &&
          (NOUN_CUE.test(match[0]) || DETERMINER_BEFORE.test(before)) &&
          !FOR_WHOM_AFTER.test(text.slice(end))
        ) {
          continue;
        }
        const not = kind === 'invite' ? NOT_BEFORE.exec(before) : null;
        if (not) {
          cues.push({ end, kind: 'uninvite', order, start: not.index });
        } else if (!negatedClause(match.index)) {
          cues.push({ end, kind, order, start: match.index });
        }
      }
    }
  }
  // "lade … ein": the names between the verb and its particle — the first
  // one after it in the sentence, past a list's commas ("lade Tom, Anna
  // und Bob ein"); "nicht" right before it ("lade Tom nicht ein") turns
  // it around.
  for (const verb of text.matchAll(SPLIT_VERB)) {
    const verbEnd = verb.index + verb[0].length;
    const [, sentenceEnd] = sentenceOf(text, verb.index);
    const rest = text.slice(verbEnd, sentenceEnd);
    const particle = PARTICLE.exec(rest);
    if (particle && !taken(verb.index, verbEnd) && !negatedClause(verb.index)) {
      const not = NOT_BEFORE.test(rest.slice(0, particle.index));
      cues.push({
        end: verbEnd,
        kind: particle[1] === 'aus' || not ? 'uninvite' : 'invite',
        order: 'first',
        start: verb.index,
      });
    }
  }
  return cues.sort((a, b) => a.start - b.start);
};

const LETTER = /[\p{L}\p{N}]/u;

/** Each whole-word occurrence of the (folded) name. */
const exactSpans = (text: string, key: string): ReadonlyArray<Span> => {
  const found: Array<Span> = [];
  for (let from = text.indexOf(key); from !== -1; from = text.indexOf(key, from + 1)) {
    const before = text[from - 1];
    const after = text[from + key.length];
    if (
      (before === undefined || !LETTER.test(before)) &&
      (after === undefined || !LETTER.test(after))
    ) {
      found.push({ at: from, length: key.length });
    }
  }
  return found;
};

const VOWEL = /[aeiouy]/;

/**
 * A name the model misspelled, found in the words: the same consonants
 * in the same places, any vowel where it wrote one — "Järg Möller" for
 * "Jörg Müller" (observed). Only for names of three letters or more.
 */
const looseSpans = (text: string, key: string): ReadonlyArray<Span> => {
  if (key.replaceAll(/\s+/g, '').length < 3) {
    return [];
  }
  const pattern = key
    .split(/\s+/)
    .map((word) =>
      [...word]
        .map((char) =>
          VOWEL.test(char) ? '[aeiouy]' : char.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`),
        )
        .join(''),
    )
    .join(String.raw`\s+`);
  return [
    ...text.matchAll(new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])`, 'gu')),
  ].map((match) => ({ at: match.index, length: match[0].length }));
};

/**
 * The people the words invite and take off the list: the names the
 * model read, each one in the words (as the words spell it — a model
 * misspells "Jörg"), in a cue's guest list, and not the user or a
 * pronoun; and every address the words hold in one, read by the code (a
 * name inside an address is not one). Without a cue there is nobody,
 * whatever the model returned. Each person once; one said both ways is
 * neither.
 */
export const inviteesOf = (
  people: ReadonlyArray<string> | undefined,
  phrase: string,
): InviteeChange => {
  const original = phrase.normalize('NFC');
  const text = fold(original);
  const { addresses, text: words } = masked(text);
  const cues = cuesIn(words);
  const invite: Array<string> = [];
  const uninvite: Array<string> = [];
  if (cues.length === 0) {
    return { invite, uninvite };
  }
  // The words' own spelling, where folding kept every character in place.
  const spell = (span: Span, fallback: string) =>
    text.length === original.length ? original.slice(span.at, span.at + span.length) : fallback;
  const inAddress = (span: Span) =>
    addresses.some(
      (address) =>
        span.at >= address.at &&
        span.at < address.at + address.length &&
        !(span.at === address.at && span.length === address.length),
    );

  // Everyone the words name, where: the model's names (outside addresses) and the addresses.
  const named: Array<{ readonly fallback: string; readonly spans: ReadonlyArray<Span> }> = [];
  for (const raw of people ?? []) {
    const name = meaningfulText(raw);
    const key = name === undefined ? '' : fold(name);
    if (name === undefined || key === '' || NOT_A_PERSON.has(key)) {
      continue;
    }
    const exact = exactSpans(text, key).filter((span) => !inAddress(span));
    const spans =
      exact.length > 0 ? exact : looseSpans(text, key).filter((span) => !inAddress(span));
    if (spans.length > 0) {
      named.push({ fallback: name, spans });
    }
  }
  const byAddress = new Map<string, Array<Span>>();
  for (const address of addresses) {
    const key = text.slice(address.at, address.at + address.length);
    byAddress.set(key, [...(byAddress.get(key) ?? []), address]);
  }
  for (const [key, spans] of byAddress) {
    named.push({ fallback: key, spans });
  }
  const covered = new Set(
    named.flatMap(({ spans }) =>
      spans.flatMap(({ at, length }) => Array.from({ length }, (_, index) => at + index)),
    ),
  );

  /** Whether the words between are only list: the other people, separators, list words. */
  const listBetween = (from: number, to: number): boolean => {
    let gap = '';
    for (let index = from; index < to; index += 1) {
      gap += covered.has(index) ? PERSON : (words[index] ?? '');
    }
    return LIST_GAP.test(gap.replaceAll(new RegExp(`${PERSON}+`, 'g'), PERSON));
  };

  /** The cue a name stands under: the nearest whose guest list reaches it, before or after. */
  const cueOf = ({ at, length }: Span): Cue | undefined => {
    const before = cues
      .filter((cue) => cue.order === 'first' && cue.end <= at && listBetween(cue.end, at))
      .at(-1);
    const lead = words.slice(0, at);
    const after =
      COMPANY_BEFORE.test(lead) || NEGATED_BEFORE.test(lead)
        ? undefined
        : cues.find(
            (cue) =>
              cue.order === 'final' &&
              cue.start >= at + length &&
              listBetween(at + length, cue.start),
          );
    if (before === undefined || after === undefined) {
      return before ?? after;
    }
    return at - before.end <= after.start - (at + length) ? before : after;
  };

  const seen = new Set<string>();
  for (const { fallback, spans } of named) {
    const name = spell(spans[0]!, fallback);
    const key = fold(name);
    if (seen.has(key) || NOT_A_PERSON.has(key)) {
      continue;
    }
    const kinds = new Set(spans.flatMap((span) => cueOf(span)?.kind ?? []));
    // Said under both ("invite Tom, then remove Tom"): no telling which.
    if (kinds.size !== 1) {
      continue;
    }
    seen.add(key);
    (kinds.has('invite') ? invite : uninvite).push(name);
  }
  return { invite, uninvite };
};

/** Whether the words say to invite anyone ("invite", "add … as a guest", "lade … ein"). */
export const invitesAnyone = (phrase: string): boolean =>
  cuesIn(masked(fold(phrase)).text).some((cue) => cue.kind === 'invite');

/** Whether the words invite anyone or take anyone off the guest list: no cue, no people. */
export const mentionsInvitees = (phrase: string): boolean =>
  cuesIn(masked(fold(phrase)).text).length > 0;

/**
 * Where the event starts in a title that opens with the invitation
 * ("Invite Tom and Anna to the planning meeting"): after the cue, the
 * invited names and "to" or "for" (and a "the").
 */
const afterOpeningInvitation = (text: string, names: ReadonlyArray<string>): number | undefined => {
  const cue = /^(?:please\s+)?invite\s+/.exec(text);
  if (!cue) {
    return undefined;
  }
  let at = cue[0].length;
  let named = false;
  for (;;) {
    const name = names.find(
      (each) => text.startsWith(each, at) && !LETTER.test(text[at + each.length] ?? ''),
    );
    if (name === undefined) {
      break;
    }
    named = true;
    at += name.length;
    const joint = /^(?:\s*,\s*|\s+and\s+|\s*&\s*)(?=\S)/.exec(text.slice(at));
    if (!joint || /^\s+(?:to|for)\s/.test(text.slice(at))) {
      break;
    }
    at += joint[0].length;
  }
  const to = named ? /^\s+(?:to|for)\s+(?:the\s+)?/.exec(text.slice(at)) : null;
  return to ? at + to[0].length : undefined;
};

/**
 * The title without the invitation the model left in it ("Lunch with
 * Sarah, invite Tom" → "Lunch with Sarah"; "Invite Tom to the planning
 * meeting" → "Planning meeting"): cut where the cue's clause starts,
 * when that tail names someone invited, or what follows an invitation
 * the title opens with. A title that is only the invitation ("Invite
 * Tom") stays, as does one whose folded text does not line up with it
 * character for character.
 */
export const titleWithoutInvitees = (title: string, invited: ReadonlyArray<string>): string => {
  const text = fold(title);
  if (invited.length === 0 || text.length !== title.length) {
    return title;
  }
  const names = invited.map(fold);
  const opening = afterOpeningInvitation(text, names);
  const rest = opening === undefined ? '' : title.slice(opening).trim();
  if (rest !== '') {
    return `${rest.charAt(0).toLocaleUpperCase()}${rest.slice(1)}`;
  }
  for (const cue of cuesIn(masked(text).text)) {
    if (cue.kind !== 'invite') {
      continue;
    }
    const cut = cue.order === 'first' ? cue.start : partOf(text, cue.start)[0];
    const tail = text.slice(cut);
    if (cut > 0 && names.some((name) => exactSpans(tail, name).length > 0)) {
      const kept = title
        .slice(0, cut)
        .replace(/(?:[\s,;:–—-]|\b(?:and|und)\b)+$/u, '')
        .trim();
      if (kept !== '') {
        return kept;
      }
    }
  }
  return title;
};

/** What the people question asks for. */
export interface PeopleParse {
  readonly people?: ReadonlyArray<string> | undefined;
}

/** Guided-generation schema; kept in sync with PeopleParse by hand. */
export const PEOPLE_JSON_SCHEMA = {
  additionalProperties: false,
  properties: { people: { items: { type: 'string' }, type: 'array' } },
  required: ['people'],
  type: 'object',
} as const;

/** The line the user's words follow in the people prompt. */
export const PEOPLE_SENTENCE_MARKER = 'Sentence: ';

export const buildPeoplePrompt = (phrase: string): string =>
  [
    'List the people the sentence says to invite to an event or to take off its guest list.',
    'Write each name or email address exactly as the sentence writes it. List nobody else:',
    'not the user, not people the event is only with, not pronouns.',
    'The sentence may be in any language.',
    `${PEOPLE_SENTENCE_MARKER}${phrase}`,
  ].join('\n');

/**
 * The names the model reads in the words, asked only when they hold a
 * cue — an invitation, or with `removals` one that takes a guest off (a
 * refinement; a new event has no guests to take off, and "ohne", "drop"
 * or "without" say other things there): no cue, no call. A failing model
 * reads as no one — the event is still made, the guests added by hand.
 */
export const readPeople = async (
  model: LanguageModel,
  phrase: string,
  { removals }: { readonly removals: boolean },
): Promise<ReadonlyArray<string>> => {
  if (!(removals ? mentionsInvitees(phrase) : invitesAnyone(phrase))) {
    return [];
  }
  try {
    const raw = (await model.generateJson({
      jsonSchema: PEOPLE_JSON_SCHEMA,
      prompt: buildPeoplePrompt(phrase),
    })) as PeopleParse | null;
    const people = raw?.people;
    return Array.isArray(people)
      ? people.filter((person): person is string => typeof person === 'string')
      : [];
  } catch {
    return [];
  }
};
