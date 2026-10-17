import { foldSearchText } from '@calendar/core';
import type { LanguageModel } from './model.ts';
import { meaningfulText } from './shared.ts';

/**
 * Who a phrase invites, read against its words. The model names the
 * people in a question of its own (`readPeople`), asked beside the
 * quick-add or refine prompt and only when the words hold a cue: those
 * prompts stay as they were (in a refinement, Apple's model named no one
 * and wrote the guest into the title instead). The code keeps a name only
 * where the words put it under an invitation cue — "invite Tom", "add
 * Anna as a guest", "lade Tom ein", "Anna einladen" — and reads from the
 * cue whether it invites or takes off the guest list ("don't invite
 * Tom", "remove Anna", "ohne Tom", "Tom ausladen"). "Lunch with Sarah"
 * names a person but invites no one: an invitation emails them, so only
 * the words that ask for one make one. A name the model gave that is not
 * in the words, or not under a cue, is dropped.
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

/**
 * Cues whose names follow them. The ones that take a guest off come
 * first: "don't invite" holds an "invite".
 */
const FIRST_CUES: ReadonlyArray<readonly [CueKind, RegExp]> = [
  [
    'uninvite',
    /\b(?:uninvit(?:e|es|ed|ing)|disinvit(?:e|es|ed|ing)|(?:don'?t|do not|no longer|not)\s+invite|remove|drop|without|ohne|entfern(?:e|en|t)?|streich(?:e|en|t)?)\b/g,
  ],
  [
    'invite',
    // "add … as a guest": an address between keeps its dots.
    /\b(?:invit(?:e|es|ed|ing)|invitations?|einladung(?:en)?|add(?=\s(?:[^.;!?]|\.(?=\S))*\bas\s+(?:an?\s+)?(?:guests?|attendees?|invitees?)\b))\b/g,
  ],
];

/** Cues whose names come before them, German verb-final. */
const FINAL_CUES: ReadonlyArray<readonly [CueKind, RegExp]> = [
  ['uninvite', /\b(?:nicht\s+(?:ein(?:zu)?laden|einlade|eingeladen)|aus(?:zu)?laden|auslade)\b/g],
  ['invite', /\b(?:ein(?:zu)?laden|einlade|eingeladen)\b/g],
];

/** "lade Tom ein" / "lade Anna aus": the verb first, its particle after the names. */
const SPLIT_VERB = /\blad(?:e|t|en)?\b/g;
const PARTICLE = /\b(ein|aus)\b/g;

/** A "with" between a cue and a name: the name is company, not a guest ("invite Tom to lunch with Sarah"). */
const WITH = /\b(?:with|mit)\b/;

/**
 * A word that rules a name out between it and its cue ("invite Anna but
 * not Tom", "invite Anna instead of Tom", "lade Anna statt Tom ein"): the
 * cue does not reach the name, and the code has no opinion about it.
 */
const NEGATION =
  'not|except|excluding|other than|apart from|instead of|rather than|nicht|ausser|ausgenommen|statt|anstatt|keine?[nm]?';
const NEGATED = new RegExp(`\\b(?:${NEGATION})\\b`);
/** …and right before a name, for a cue after it ("Anna und nicht Tom einladen"). */
const NEGATED_BEFORE = new RegExp(`\\b(?:${NEGATION})\\s+$`);

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

/** An address in the words: read by the code, since a model shortens "tom@example.com" to "Tom". */
const ADDRESS = /[^\s@,;:()<>"']+@[^\s@,;:()<>"']+\.[a-z]{2,}/g;

/** Where sentences end: a period only before a space or the end, so an address keeps its dots. */
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

const cuesIn = (text: string): ReadonlyArray<Cue> => {
  const cues: Array<Cue> = [];
  const taken = (start: number, end: number) =>
    cues.some((cue) => start < cue.end && cue.start < end);
  for (const [order, list] of [
    ['first', FIRST_CUES],
    ['final', FINAL_CUES],
  ] as const) {
    for (const [kind, pattern] of list) {
      for (const match of text.matchAll(pattern)) {
        const end = match.index + match[0].length;
        if (!taken(match.index, end)) {
          cues.push({ end, kind, order, start: match.index });
        }
      }
    }
  }
  // "lade … ein": the names between the verb and its particle.
  for (const verb of text.matchAll(SPLIT_VERB)) {
    const [, partEnd] = partOf(text, verb.index);
    const rest = text.slice(verb.index + verb[0].length, partEnd);
    const particle = [...rest.matchAll(PARTICLE)].at(-1);
    const verbEnd = verb.index + verb[0].length;
    if (particle && !taken(verb.index, verbEnd)) {
      cues.push({
        end: verbEnd,
        kind: particle[1] === 'aus' ? 'uninvite' : 'invite',
        order: 'first',
        start: verb.index,
      });
    }
  }
  return cues;
};

const LETTER = /[\p{L}\p{N}]/u;

/** Where a name stands in the words. */
interface Span {
  readonly at: number;
  readonly length: number;
}

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
 * The cue a name at `at` stands under: the nearest one before it in its
 * sentence whose names follow it (no "with" between), or the nearest one
 * after it in its clause whose names come before it — neither across a
 * word that rules the name out.
 */
const cueOf = (
  text: string,
  cues: ReadonlyArray<Cue>,
  at: number,
  length: number,
): Cue | undefined => {
  const [sentenceStart] = sentenceOf(text, at);
  const [, partEnd] = partOf(text, at);
  const before = cues
    .filter(
      (cue) =>
        cue.order === 'first' &&
        cue.end <= at &&
        cue.start >= sentenceStart &&
        !WITH.test(text.slice(cue.end, at)) &&
        !NEGATED.test(text.slice(cue.end, at)),
    )
    .at(-1);
  const after = cues
    .filter(
      (cue) =>
        cue.order === 'final' &&
        cue.start >= at + length &&
        cue.end <= partEnd &&
        !NEGATED_BEFORE.test(text.slice(0, at)),
    )
    .sort((a, b) => a.start - b.start)[0];
  if (before === undefined || after === undefined) {
    return before ?? after;
  }
  return at - before.end <= after.start - (at + length) ? before : after;
};

/**
 * The people the words invite and take off the list: the names the
 * model read, each one in the words (as the words spell it — a model
 * misspells "Jörg"), under a cue, and not the user or a pronoun; and
 * every address the words hold under a cue, read by the code (a model
 * shortened "tom@example.com" to "Tom": a name inside an address is not
 * one). Without a cue anywhere there is nobody, whatever the model
 * returned. Each person once.
 */
export const inviteesOf = (
  people: ReadonlyArray<string> | undefined,
  phrase: string,
): InviteeChange => {
  const original = phrase.normalize('NFC');
  const text = fold(original);
  const cues = [...cuesIn(text)].sort((a, b) => a.start - b.start);
  const invite: Array<string> = [];
  const uninvite: Array<string> = [];
  if (cues.length === 0) {
    return { invite, uninvite };
  }
  // The words' own spelling, where folding kept every character in place.
  const spell = (span: Span, fallback: string) =>
    text.length === original.length ? original.slice(span.at, span.at + span.length) : fallback;
  const addresses: ReadonlyArray<Span> = [...text.matchAll(ADDRESS)].map((match) => ({
    at: match.index,
    length: match[0].length,
  }));
  const inAddress = (span: Span) =>
    addresses.some(
      (address) =>
        span.at >= address.at &&
        span.at < address.at + address.length &&
        !(span.at === address.at && span.length === address.length),
    );
  const seen = new Set<string>();
  const take = (spans: ReadonlyArray<Span>, fallback: string) => {
    const [first] = spans;
    if (first === undefined) {
      return;
    }
    const name = spell(first, fallback);
    const key = fold(name);
    if (seen.has(key) || NOT_A_PERSON.has(key)) {
      return;
    }
    const kinds = new Set(
      spans.flatMap((span) => {
        const cue = cueOf(text, cues, span.at, span.length);
        return cue ? [cue.kind] : [];
      }),
    );
    // Said under both ("invite Anna, without Tom … Tom"): no telling which.
    if (kinds.size !== 1) {
      return;
    }
    seen.add(key);
    (kinds.has('invite') ? invite : uninvite).push(name);
  };
  for (const raw of people ?? []) {
    const name = meaningfulText(raw);
    const key = name === undefined ? '' : fold(name);
    if (name === undefined || key === '' || NOT_A_PERSON.has(key)) {
      continue;
    }
    const exact = exactSpans(text, key).filter((span) => !inAddress(span));
    take(exact.length > 0 ? exact : looseSpans(text, key).filter((span) => !inAddress(span)), name);
  }
  for (const address of addresses) {
    take([address], text.slice(address.at, address.at + address.length));
  }
  return { invite, uninvite };
};

/** Whether the words say to invite anyone ("invite", "add … as a guest", "lade … ein"). */
export const invitesAnyone = (phrase: string): boolean =>
  cuesIn(fold(phrase)).some((cue) => cue.kind === 'invite');

/** Whether the words invite anyone or take anyone off the guest list: no cue, no people. */
export const mentionsInvitees = (phrase: string): boolean => cuesIn(fold(phrase)).length > 0;

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
  for (const cue of [...cuesIn(text)].sort((a, b) => a.start - b.start)) {
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
