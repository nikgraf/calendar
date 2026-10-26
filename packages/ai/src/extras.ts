import { foldSearchText } from '@calendar/core';
import { COMPOUND_NUMBER, LENGTH_WORD, NUMBER_WORD, quantityOf } from './grounding.ts';

/**
 * What a phrase says beside the event itself: the notifications it asks
 * for ("remind me 30 minutes before", "erinnere mich eine Stunde
 * vorher", "notify me 15 minutes and an hour before", "no reminder") and
 * the note it adds ("note: bring the contract", "notier, dass ich die
 * Karte mitnehmen muss", "add to the notes: bring the slides").
 *
 * Read by the code alone, with no field in the model's schema: an offset
 * is a small grammar, and a note is the phrase's own words, which a
 * model would only reword or invent ("unknown"). The clauses then leave
 * the phrase (`rest`), so the model and the grounding see the event
 * alone — a title never carries "remind me 30 minutes before", the to-do
 * cue is not read in a notification ("remind me … before" is one,
 * "remind me to call the bank" is not), and "15 minutes before" is not
 * the event's length. A turn that says nothing else ("notify me 15
 * minutes before") leaves no words for the model at all.
 */

export type NotesChange =
  | { readonly kind: 'add'; readonly text: string }
  | { readonly kind: 'clear' }
  | { readonly kind: 'replace'; readonly text: string };

/**
 * What the words do to the notifications, in minutes before the start as
 * Google and EventKit count them: offsets to add and offsets to take off,
 * after clearing the draft's own when the words say so ("no reminder",
 * "… instead", "change the reminder to …").
 */
export interface ReminderChange {
  readonly add: ReadonlyArray<number>;
  readonly clear: boolean;
  readonly remove: ReadonlyArray<number>;
}

export interface PhraseExtras {
  readonly notes?: NotesChange | undefined;
  readonly reminders?: ReminderChange | undefined;
  /** The phrase without the clauses read here: what the model and the grounding get. */
  readonly rest: string;
}

/**
 * The phrase lower-cased and without accents, every character kept in
 * place (ß stays ß), so a span found here is the same span of the phrase
 * and a note keeps its own spelling.
 */
const foldInPlace = (text: string): string => {
  let folded = '';
  for (const char of text) {
    const plain = foldSearchText(char).replaceAll(/[‘’`]/g, "'");
    const lower = char.toLowerCase();
    folded += plain.length === char.length ? plain : lower.length === char.length ? lower : char;
  }
  return folded;
};

interface Span {
  readonly end: number;
  readonly start: number;
}

// --- Notifications --------------------------------------------------------

const MINUTE_UNITS = String.raw`minutes?|minuten?|mins?\.?`;
const HOUR_UNITS = String.raw`hours?|hrs?|h|stunden?|std\.?`;
const DAY_UNITS = String.raw`days?|tage?n?`;
const WEEK_UNITS = String.raw`weeks?|wochen?`;
const UNIT = `${MINUTE_UNITS}|${HOUR_UNITS}|${DAY_UNITS}|${WEEK_UNITS}`;

/** A number as said, or the article that means one ("an hour", "the day", "einen Tag", "am Tag"). */
const AMOUNT = String.raw`\d+(?:[.,]\d+)?|${COMPOUND_NUMBER}|${LENGTH_WORD}|${NUMBER_WORD}|an?|eine?[nmrs]?|ein|the|den|am`;
/** A number alone, sharing the unit of the next ("10 and 30 minutes before"). */
const BARE_AMOUNT = String.raw`\d+(?:[.,]\d+)?|${COMPOUND_NUMBER}|${LENGTH_WORD}|${NUMBER_WORD}`;

/** Offsets said whole, in minutes. */
const SPECIAL_OFFSETS: ReadonlyArray<readonly [string, number]> = [
  [
    String.raw`an? hour and a half|one and a half hours?|eineinhalb stunden?|anderthalb stunden?`,
    90,
  ],
  [String.raw`half an hour|a half[- ]hour|(?:eine|einer) halben? stunde|halbe stunde`, 30],
  [String.raw`(?:a )?quarter(?: of an)? hour|(?:eine |einer )?viertelstunde`, 15],
  [String.raw`(?:am |den )?vortag`, 1440],
];
const SPECIAL = SPECIAL_OFFSETS.map(([source]) => `(?:${source})`).join('|');
/** The tests for which special offset a token is, in the order above. */
const SPECIALS = SPECIAL_OFFSETS.map(
  ([source, minutes]) => [new RegExp(`^(?:${source})$`), minutes] as const,
);

const NO_LETTER = String.raw`(?![a-z])`;
const WITH_UNIT = String.raw`(?:${AMOUNT})[\s-]*(?:${UNIT})${NO_LETTER}`;
const OFFSET = String.raw`(?:${SPECIAL})${NO_LETTER}|${WITH_UNIT}|(?:${BARE_AMOUNT})${NO_LETTER}`;
const OFFSET_WITH_UNIT = String.raw`(?:${SPECIAL})${NO_LETTER}|${WITH_UNIT}`;
const LIST_GAP = String.raw`(?:\s*,\s*|\s*&\s*|\s+(?:and|und|or|oder|plus|sowie)\s+)`;
const OFFSETS = String.raw`\b(?:${OFFSET})(?:${LIST_GAP}(?:${OFFSET}))*`;

const TOKEN = new RegExp(
  String.raw`(${SPECIAL})${NO_LETTER}|\b(${AMOUNT})(?:[\s-]*(${UNIT}))?${NO_LETTER}`,
  'g',
);

const unitMinutes = (unit: string): number =>
  /^(?:min|minute)/.test(unit)
    ? 1
    : /^(?:h|hr|hour|stund|std)/.test(unit)
      ? 60
      : /^(?:day|tag)/.test(unit)
        ? 1440
        : 10_080;

const amountOf = (token: string): number =>
  /^(?:the|den|am|ein|eine|einen|einem|einer|eines)$/.test(token) ? 1 : quantityOf(token);

/**
 * The minutes an offsets list names ("15 minutes and an hour", "10 and 30
 * minutes", "the day"): a number without a unit takes the next unit said,
 * or minutes when none follows. Nothing readable gives none.
 */
const minutesOf = (offsets: string): ReadonlyArray<number> => {
  const minutes: Array<number> = [];
  let pending: Array<number> = [];
  for (const match of offsets.matchAll(TOKEN)) {
    const [, special, amount, unit] = match;
    if (special !== undefined) {
      minutes.push(SPECIALS.find(([test]) => test.test(special))?.[1] ?? 0);
      continue;
    }
    const quantity = amountOf(amount!);
    if (!Number.isFinite(quantity)) {
      continue;
    }
    if (unit === undefined) {
      pending.push(quantity);
      continue;
    }
    const per = unitMinutes(unit);
    minutes.push(...pending.map((waiting) => waiting * per), quantity * per);
    pending = [];
  }
  minutes.push(...pending);
  return minutes.map((value) => Math.round(value)).filter((value) => value >= 0);
};

const CUE = String.raw`remind me|reminders?|notifications?|notify me|alert me|alerts?|ping me|heads[- ]up|erinnere mich|erinner mich|erinnerung(?:en)?|benachrichtige mich|benachrichtigung(?:en)?`;
const NOUN = String.raw`reminders?|notifications?|alerts?|erinnerung(?:en)?|benachrichtigung(?:en)?`;
/** The word that makes an offset a lead ("30 minutes before"); after a cue, "early" and "früher" count too. */
const BEFORE = String.raw`before(?:hand)?(?:\s+(?:it starts|it|the event|the start|start|the meeting))?|in advance|ahead(?: of time)?|early|earlier|prior|vorher|davor|zuvor|im voraus|vorab|fruher|vor beginn|vor dem (?:termin|start|beginn)`;
/** Without a cue, only the words that cannot mean a moved start ("an hour earlier" moves the event). */
const BEFORE_BARE = String.raw`before(?:hand)?|in advance|ahead(?: of time)?|vorher|davor|zuvor|im voraus|vorab`;
const AT_START = String.raw`at (?:the )?(?:start|time|beginning)(?: of the event)?|at event time|when it starts|zu beginn|bei beginn|zum beginn|zum start`;
/** Words that may trail a clause and go with it. */
const TAIL = String.raw`(?:\s+(?:as well|too|also|auch|ebenfalls|noch|dazu|please|bitte))*`;
const INSTEAD = String.raw`(?:\s+(?:instead|stattdessen))?`;
const ARTICLE = String.raw`(?:\s+(?:a|an|the|one|einer?|eine|den|die|das))?`;

interface ReminderClause extends Span {
  readonly kind: 'add' | 'clear' | 'remove' | 'replace';
  readonly minutes: ReadonlyArray<number>;
}

/** Every shape a notification is asked for in; group 1 the offsets, group 2 "at the start". */
const REMINDER_SHAPES: ReadonlyArray<{
  readonly kind: 'add' | 'replace';
  readonly pattern: RegExp;
}> = [
  // "remind me 30 minutes before", "notification an hour before", "Erinnerung 10 Minuten vorher", "notify me at the start"
  {
    kind: 'add',
    pattern: new RegExp(
      String.raw`\b(?:${CUE})(?:\s*:)?(?:\s+(?:me|mich|mir))?(?:\s+(?:with|of|for|mit|von))?${ARTICLE}\s+(?:(${OFFSETS})\s+(?:${BEFORE})|(${AT_START}))${NO_LETTER}${TAIL}${INSTEAD}`,
      'g',
    ),
  },
  // "change the reminder to 10 minutes before", "set the notification to an hour before"
  {
    kind: 'replace',
    pattern: new RegExp(
      String.raw`\b(?:change|set|make|move|update|switch|replace|put|andere?|setze?|stelle?|mach)\s+(?:the\s+|my\s+|den\s+|die\s+|das\s+|meine\s+)?(?:${NOUN})\s+(?:to|at|auf|zu)\s+(?:(${OFFSETS})(?:\s+(?:${BEFORE}))?|(${AT_START}))${NO_LETTER}${TAIL}`,
      'g',
    ),
  },
  // "with a 30 minute reminder", "a 30-minute notification before", "mit 10 Minuten Erinnerung"
  {
    kind: 'add',
    pattern: new RegExp(
      String.raw`\b(?:(?:with|mit)\s+)?(?:(?:a|an|einer?|eine)\s+)?(${OFFSET_WITH_UNIT})[\s-]*(?:${NOUN})(?:\s+(?:${BEFORE}))?${NO_LETTER}${TAIL}${INSTEAD}`,
      'g',
    ),
  },
  // "eine Stunde vorher erinnern", "30 minutes before, remind me"
  {
    kind: 'add',
    pattern: new RegExp(
      String.raw`(${OFFSETS})\s+(?:${BEFORE_BARE})[\s,]+(?:erinnern|benachrichtigen|remind me|notify me|alert me|${NOUN})${NO_LETTER}${TAIL}${INSTEAD}`,
      'g',
    ),
  },
  // Bare, as a clause of its own: "and an hour before as well", "Dentist at 10, 30 minutes before"
  {
    kind: 'add',
    pattern: new RegExp(
      String.raw`(${OFFSETS})\s+(?:${BEFORE_BARE})${NO_LETTER}${TAIL}${INSTEAD}(?=\s*(?:$|[,;.!?]))`,
      'g',
    ),
  },
];
/** The bare shape stands only where a clause starts. */
const BARE_SHAPE = REMINDER_SHAPES.length - 1;

/** What may precede a clause of its own: the start, punctuation, or a joining word. */
const CLAUSE_START =
  /(?:^|[,;:.!?])\s*(?:(?:and|und|plus|also|auch|sowie|then|dann|bitte|please|oh)\s+)?$|\s+(?:and|und|plus|also|auch|sowie|&|then|dann|bitte|please)\s+$/;

/** A negation right before a notification: the offset is taken off ("remove the 15 minute reminder"). */
const NEGATED =
  /\b(?:remove|delete|drop|cancel|without|not|no|don'?t|do not|never|ohne|keine?[nmrs]?|nicht|entferne?|losche?|streiche?)\s+(?:the\s+|den\s+|die\s+|das\s+|my\s+|meine\s+)?$/;

/** A clearing said not to happen ("don't clear the notes", "do not remove the reminders"): no change, and the model reads the words. */
const DENIED =
  /\b(?:don'?t|do not|does not|never|not|nicht|nie)\s+(?:(?:the|all|any|my|die|den|das|alle|meine)\s+)?$/;

/** The notifications taken off altogether. */
const CLEAR_REMINDERS = new RegExp(
  [
    String.raw`\b(?:no|without|remove|delete|drop|clear|cancel|skip|disable|turn off|keine?[nmrs]?|ohne|entferne?|losche?|streiche?|deaktiviere?)\s+(?:the\s+|all\s+|any\s+|my\s+|alle\s+|die\s+|jede\s+|meine\s+)?(?:${NOUN})${NO_LETTER}`,
    String.raw`\b(?:don'?t|do not|never)\s+(?:remind|notify|alert)\s+me${NO_LETTER}`,
    String.raw`\b(?:${NOUN})\s+(?:entfernen|loschen|weg|aus|off)${NO_LETTER}`,
    String.raw`\bnicht\s+erinnern${NO_LETTER}`,
  ].join('|'),
  'g',
);

const reminderClauses = (text: string): ReadonlyArray<ReminderClause> => {
  const found: Array<ReminderClause> = [];
  REMINDER_SHAPES.forEach(({ kind, pattern }, shape) => {
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const start = match.index;
      const end = start + match[0].length;
      const minutes = match[2] === undefined ? minutesOf(match[1] ?? '') : [0];
      // A match that does not stand ("at 7, 30 minutes before" read from the
      // 7) is dropped, and the search goes on from the next character, so a
      // clause it swallowed ("30 minutes before") is found on its own.
      if (
        minutes.length === 0 ||
        (shape === BARE_SHAPE && !CLAUSE_START.test(text.slice(0, start)))
      ) {
        pattern.lastIndex = start + 1;
        continue;
      }
      const negated = NEGATED.exec(text.slice(0, start));
      const replaces = kind === 'replace' || /\b(?:instead|stattdessen)$/.test(match[0]);
      found.push({
        end,
        kind: negated ? 'remove' : replaces ? 'replace' : 'add',
        minutes,
        start: negated ? negated.index : start,
      });
    }
  });
  for (const match of text.matchAll(CLEAR_REMINDERS)) {
    if (!DENIED.test(text.slice(0, match.index))) {
      found.push({
        end: match.index + match[0].length,
        kind: 'clear',
        minutes: [],
        start: match.index,
      });
    }
  }
  return distinct(found);
};

/** Of overlapping clauses, the one that starts first, then the longer. */
const distinct = <T extends Span>(clauses: ReadonlyArray<T>): ReadonlyArray<T> => {
  const kept: Array<T> = [];
  for (const clause of [...clauses].sort((a, b) => a.start - b.start || b.end - a.end)) {
    const last = kept.at(-1);
    if (last === undefined || clause.start >= last.end) {
      kept.push(clause);
    }
  }
  return kept;
};

/**
 * One change from every notification clause, composed: cleared when any
 * clause clears or replaces, the offsets added by additions and
 * replacements, the offsets taken off by removals (an offset both added
 * and removed is added).
 */
const reminderChange = (clauses: ReadonlyArray<ReminderClause>): ReminderChange | undefined => {
  const minutes = (...kinds: ReadonlyArray<ReminderClause['kind']>) => [
    ...new Set(clauses.filter((clause) => kinds.includes(clause.kind)).flatMap((c) => c.minutes)),
  ];
  const clear = clauses.some((clause) => clause.kind === 'replace' || clause.kind === 'clear');
  const add = minutes('replace', 'add');
  const remove = minutes('remove').filter((offset) => !add.includes(offset));
  return !clear && add.length === 0 && remove.length === 0 ? undefined : { add, clear, remove };
};

// --- Notes ----------------------------------------------------------------

const NOTE_WORDS = String.raw`notes?|notiz(?:en)?|description|details?|beschreibung|anmerkung(?:en)?|bemerkung(?:en)?|vermerk`;
/** The note word itself, which a verb or a dash can introduce a note with; "details" and "description" need a colon. */
const NOTE_NOUN = String.raw`notes?|notiz(?:en)?`;
const COLON = String.raw`[:：–—-]`;
const NOTE_COLON = String.raw`[:：]`;

/** Where a note's words begin, in every way one is introduced; what follows is the note. */
const NOTE_CUE = new RegExp(
  [
    // "note: …", "description: …"; "notes - …" (a dash after "details" is a title's)
    String.raw`\b(?:${NOTE_WORDS})\s*${NOTE_COLON}\s*`,
    String.raw`\b(?:${NOTE_NOUN})\s*[–—-]\s+`,
    // "note that …", "noting that …", "note down …"
    String.raw`\bnot(?:e|es|ing)\s+(?:that|saying|down that|down)\s+`,
    // "add a note: …", "add a note that …", "make a note …"
    String.raw`\b(?:add|adding|make|put|leave|include|attach)\s+(?:(?:a|an|the|some)\s+)?(?:${NOTE_NOUN})(?:\s+(?:that|saying))?\s*${COLON}?\s*`,
    // "with a note that …", "with the note: …", 'with the note "…"'
    String.raw`\bwith\s+(?:(?:a|the)\s+)?(?:${NOTE_WORDS})\s*(?:(?:that|saying)\s+|${COLON}\s*|(?=["'“„«]))`,
    // "add to the notes: …", "append to the notes …", "put it in the description: …"
    String.raw`\b(?:add|append|put|write|adding)\s+(?:(?:it|this|that)\s+)?(?:to|in|into)\s+(?:the\s+)?(?:${NOTE_WORDS})\s*${COLON}?\s*(?:that\s+)?`,
    // "in the notes: …", "to the description: …" ("Intro to notes app" is a title)
    String.raw`\b(?:to|in|into)\s+(?:the\s+)?(?:${NOTE_WORDS})\s*(?:${NOTE_COLON}\s*|that\s+)`,
    // "notier, dass …", "notiere dir: …", "notieren: …"
    String.raw`\bnotier(?:e|t|en)?(?:\s+(?:dir|mir|bitte))?\s*[,:：–—-]?\s*(?:dass\s+)?`,
    // "mit der Notiz: …", "mit Notiz, dass …", "als Anmerkung: …", "mit dem Hinweis, dass …"
    String.raw`\b(?:mit|als)\s+(?:(?:der|dem|einer|eine|ein)\s+)?(?:${NOTE_WORDS}|hinweis)\s*${COLON}?\s*(?:,?\s*dass\s+)?`,
    // "merk dir, dass …", "vermerke: …", "schreib dazu: …"
    String.raw`\b(?:merke?\s+dir|vermerke?|schreibe?\s+(?:dazu|rein|dran))\s*[,:：–—-]?\s*(?:dass\s+)?`,
    // "zu den Notizen: …", "in die Notizen …"
    String.raw`\b(?:zu\s+den|in\s+die|in\s+den)\s+(?:${NOTE_WORDS})\s*${COLON}?\s*(?:dass\s+)?`,
  ].join('|'),
  'g',
);

/** The notes replaced: "replace the notes with …", "set the description to …", "ersetze die Notiz durch …". */
const REPLACE_NOTES = new RegExp(
  String.raw`\b(?:replace|change|set|overwrite|ersetze?|andere?|setze?)\s+(?:(?:the|my|die|den|das|meine)\s+)?(?:${NOTE_WORDS})(?:\s+(?:to|with|by|durch|mit|zu|auf))?\s*${COLON}?\s*`,
  'g',
);

/** The notes taken off. */
const CLEAR_NOTES = new RegExp(
  [
    String.raw`\b(?:remove|delete|drop|clear|erase|without|no)\s+(?:(?:the|all|any|my)\s+)?(?:${NOTE_WORDS})${NO_LETTER}(?!\s*${COLON})(?:\s+(?:about|on|regarding)\s+[^,;.!?]*)?`,
    String.raw`\b(?:losche?|entferne?|streiche?)\s+(?:(?:die|alle|den|das|meine)\s+)?(?:${NOTE_WORDS})${NO_LETTER}(?:\s+(?:uber|zu|zum|zur|von)\s+[^,;.!?]*)?`,
    String.raw`\b(?:ohne|keine?[nmrs]?)\s+(?:${NOTE_WORDS})${NO_LETTER}`,
    String.raw`\b(?:${NOTE_WORDS})\s+(?:loschen|entfernen|weg|leeren)${NO_LETTER}`,
  ].join('|'),
  'g',
);

/**
 * Where a note's words end before the phrase does: at a clause about
 * whom to invite (the notification clauses are bounds of their own, so a
 * note may mention a reminder), or at the next note.
 */
const NOTE_END = new RegExp(
  String.raw`(?:[,;.]\s*(?:(?:and|und|also|auch|plus|sowie|then|dann)\s+)?|\s+(?:and|und|also|auch|plus|sowie|then|dann)\s+)(?=(?:please\s+|bitte\s+)?(?:invit(?:e|es|ed|ing)|uninvite|lade?\s|einladen|einlade))`,
  'g',
);

/**
 * A to-do's own action, in which a note word is the thing to do ("remind
 * me to add notes to the report"): the to-do cue stands earlier in the
 * same clause, with no punctuation or "and" between.
 */
const WITHIN_CLAUSE = String.raw`(?:(?!\b(?:and|und)\b)[^,;.!?])*`;
const TODO_LEAD = new RegExp(
  String.raw`(?:^|[,;.!?]|\b(?:and|und)\b)${WITHIN_CLAUSE}\b(?:remind me|reminder|don'?t forget|dont forget|i (?:need|have) to|i must|ich muss|erinnere mich|erinnerung|nicht vergessen|aufgabe|to-?do)\b${WITHIN_CLAUSE}$`,
);

/** What a note's words are trimmed of at either end. */
const NOTE_EDGE = /^[\s.,;:!?"'“”„«»()-]+|[\s.,;:!?"'“”„«»()-]+$/gu;
/** A joining word left at a note's end once the clause after it is cut. */
const JOIN_AT_END = /\s+(?:and|und|also|auch|plus|sowie|then|dann|bitte|please)$/iu;

interface NoteClause extends Span {
  readonly kind: NotesChange['kind'];
  readonly text: string;
}

const noteClauses = (
  phrase: string,
  text: string,
  reminders: ReadonlyArray<Span>,
): ReadonlyArray<NoteClause> => {
  const bounds = reminders.map((span) => span.start);
  // The words before a cue, the notification clauses blanked: "remind me
  // an hour before and note that …" is no to-do's action.
  const before = (index: number) =>
    reminders
      .reduce(
        (blanked, span) =>
          blanked.slice(0, span.start) +
          ' '.repeat(span.end - span.start) +
          blanked.slice(span.end),
        text,
      )
      .slice(0, index);
  const cues = [
    ...[...text.matchAll(NOTE_CUE)]
      .filter((match) => !TODO_LEAD.test(before(match.index)))
      .map((match) => ({
        end: match.index + match[0].length,
        kind: 'add' as const,
        start: match.index,
      })),
    ...[...text.matchAll(REPLACE_NOTES)]
      .filter((match) => !DENIED.test(text.slice(0, match.index)))
      .map((match) => ({
        end: match.index + match[0].length,
        kind: 'replace' as const,
        start: match.index,
      })),
  ];
  const starts = distinct(cues);
  const found: Array<NoteClause> = [];
  starts.forEach((cue, index) => {
    const next = starts[index + 1]?.start;
    const stops = [
      text.length,
      ...(next === undefined ? [] : [next]),
      ...bounds.filter((bound) => bound >= cue.end),
    ];
    let end = Math.min(...stops);
    NOTE_END.lastIndex = cue.end;
    const boundary = NOTE_END.exec(text);
    if (boundary && boundary.index < end) {
      end = boundary.index;
    }
    const body = phrase
      .slice(cue.end, end)
      .replaceAll(NOTE_EDGE, '')
      .replace(JOIN_AT_END, '')
      .replaceAll(NOTE_EDGE, '');
    if (body !== '') {
      found.push({ end, kind: cue.kind, start: cue.start, text: body });
    }
  });
  for (const match of text.matchAll(CLEAR_NOTES)) {
    if (!DENIED.test(text.slice(0, match.index))) {
      found.push({
        end: match.index + match[0].length,
        kind: 'clear',
        start: match.index,
        text: '',
      });
    }
  }
  return distinct(found);
};

const notesChange = (clauses: ReadonlyArray<NoteClause>): NotesChange | undefined => {
  if (clauses.length === 0) {
    return undefined;
  }
  const text = clauses
    .filter((clause) => clause.kind !== 'clear')
    .map((clause) => clause.text)
    .join('\n');
  if (clauses.some((clause) => clause.kind === 'replace' || clause.kind === 'clear')) {
    return text === '' ? { kind: 'clear' } : { kind: 'replace', text };
  }
  return { kind: 'add', text };
};

// --- The phrase without them ----------------------------------------------

/** What leads into a clause and goes with it: punctuation, or a joining word. */
const LEAD =
  /(?:^|[,;:.!?]\s*|\s+)(?:(?:and|und|plus|sowie|also|auch|with|mit|then|dann|bitte|please|oh)\s+)?$/;

/** The phrase with the clauses cut out, its joints mended. */
const without = (phrase: string, text: string, spans: ReadonlyArray<Span>): string => {
  let rest = '';
  let at = 0;
  for (const span of spans) {
    const lead = LEAD.exec(text.slice(at, span.start));
    rest += phrase.slice(at, lead ? at + lead.index : span.start);
    at = span.end;
  }
  rest += phrase.slice(at);
  return rest
    .replaceAll(/\s+/gu, ' ')
    .replaceAll(/\s*[,;]\s*(?=[,;])/gu, '')
    .replaceAll(/^[\s,;:.!?–—-]+|[\s,;:.!?–—([-]+$/gu, '')
    .replace(/^(?:and|und|plus|sowie|also|auch|then|dann)\s+/iu, '')
    .replace(/\s+(?:and|und|plus|sowie|also|auch|with|mit|then|dann)$/iu, '')
    .replaceAll(/[\s,;:.!?–—([-]+$/gu, '');
};

/**
 * The notifications and the note a phrase asks for, and the phrase
 * without those clauses. A phrase that asks for neither comes back whole.
 */
export const readExtras = (phrase: string): PhraseExtras => {
  const text = foldInPlace(phrase);
  const reminders = reminderClauses(text);
  const notes = noteClauses(phrase, text, reminders);
  const spans = distinct([...reminders, ...notes]);
  if (spans.length === 0) {
    return { rest: phrase };
  }
  const reminderClausesKept = reminders.filter((clause) => spans.includes(clause));
  const noteClausesKept = notes.filter((clause) => spans.includes(clause));
  const change = reminderChange(reminderClausesKept);
  const noted = notesChange(noteClausesKept);
  return {
    ...(noted === undefined ? {} : { notes: noted }),
    ...(change === undefined ? {} : { reminders: change }),
    rest: without(phrase, text, spans),
  };
};
