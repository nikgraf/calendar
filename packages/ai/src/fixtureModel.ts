import { Temporal } from '@calendar/core';
import { CAPTURE_TEXT_MARKER, type CaptureItemParse, type CaptureParse } from './capture.ts';
import { FIND_TIME_PHRASE_MARKER, type FindTimeParse } from './findTime.ts';
import type { LanguageModel } from './model.ts';
import {
  SEARCH_QUERY_CURRENT_MARKER,
  SEARCH_QUERY_PHRASE_MARKER,
  type SearchQueryParse,
} from './searchQuery.ts';
import { TextRecognitionError, type ImageInput, type TextRecognizer } from './textRecognition.ts';

/**
 * A stand-in for the models both e2e suites can run on any machine. It
 * does no language work: the input is written in a tiny grammar, one
 * event per line —
 *
 *     Title | +N or YYYY-MM-DD | HH:MM-HH:MM | Location
 *
 * — and `+N` counts days from today, so a spec never computes a date.
 *
 * - The Assistant's tuned prompt (`tuned.ts`, asked without a schema): a
 *   first phrase in the grammar, with extras after a fifth bar
 *   (`invite A and B`, `remind N`, `note: …`), makes an event; `todo:` in
 *   front makes a to-do; any other phrase is a title on today. A later
 *   turn answers the draft it was shown, changed only by what the turn
 *   names: the grammar with empty parts unchanged (`| | 10:00-11:00`), or
 *   one extra (`invite Tom`, `remove Anna`, `remind 60`, `note: …`,
 *   `due +0`, `repeat weekly`, `repeat none`).
 * - Capture: one event per line of the grammar.
 * - A finder sentence (`find 30 min tomorrow morning | Focus`): the title
 *   after the bar and an hour; the finder reads the rest from the words.
 * - A search turn: `terms | from..to | location | people | calendar |
 *   kind` — days as `+N`, `-N` or ISO, a single day alone, people and
 *   calendars comma-separated, kind `tasks` or `events` — applied to the
 *   current filters, an empty part unchanged; a sentence without a bar
 *   replaces the words only.
 */

const TODAY = /Today is (\d{4}-\d{2}-\d{2})/;
const RELATIVE_DAY = /^\+(\d+)$/;
const TIME_RANGE = /^(\d{2}:\d{2})(?:-(\d{2}:\d{2}))?$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

const parseLine = (line: string, referenceDate: string): CaptureItemParse | undefined => {
  const [title = '', when = '', time = '', location = ''] = line
    .split('|')
    .map((part) => part.trim());
  if (!title) {
    return undefined;
  }
  const relative = RELATIVE_DAY.exec(when);
  const date = relative
    ? Temporal.PlainDate.from(referenceDate)
        .add({ days: Number(relative[1]) })
        .toString()
    : when || undefined;
  const range = TIME_RANGE.exec(time);
  return {
    title,
    ...(date ? { date } : {}),
    ...(range ? { startTime: range[1] } : {}),
    ...(range?.[2] ? { endTime: range[2] } : {}),
    ...(location ? { location } : {}),
  };
};

const referenceDateOf = (prompt: string): string => {
  const match = TODAY.exec(prompt);
  if (!match?.[1]) {
    throw new Error('fixture model: the prompt names no reference date');
  }
  return match[1];
};

const textAfter = (prompt: string, marker: string): string => {
  const index = prompt.indexOf(marker);
  if (index === -1) {
    throw new Error(`fixture model: the prompt has no "${marker.trim()}" marker`);
  }
  return prompt.slice(index + marker.length);
};

/** A day in the search grammar: `+N` / `-N` days from the reference date, or ISO. */
const searchDay = (token: string, referenceDate: string): string | undefined => {
  const relative = /^([+-]\d+)$/.exec(token);
  if (relative) {
    return Temporal.PlainDate.from(referenceDate)
      .add({ days: Number(relative[1]) })
      .toString();
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(token) ? token : undefined;
};

const list = (part: string): ReadonlyArray<string> =>
  part
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');

const searchTurn = (
  current: SearchQueryParse,
  phrase: string,
  referenceDate: string,
): SearchQueryParse => {
  if (!phrase.includes('|')) {
    return { ...current, terms: phrase.split(/\s+/).filter((word) => word !== '') };
  }
  const [terms = '', days = '', location = '', people = '', calendars = '', kind = ''] = phrase
    .split('|')
    .map((part) => part.trim());
  const [first = '', last = first] = days.split('..').map((part) => part.trim());
  const from = searchDay(first, referenceDate);
  const to = searchDay(last, referenceDate);
  return {
    ...current,
    ...(terms ? { terms: terms.split(/\s+/) } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
    ...(location ? { location } : {}),
    ...(people ? { people: list(people) } : {}),
    ...(calendars ? { calendars: list(calendars) } : {}),
    ...(kind === 'tasks' ? { kind: 'task' } : kind === 'events' ? { kind: 'event' } : {}),
  };
};

/** The tuned prompt's today: the day list's entry marked "(today)". */
const TUNED_TODAY = /Days: \w+ (\d{4}-\d{2}-\d{2}) \(today\)/;

/** A day in the fixture grammar: `+N` days from today, or `YYYY-MM-DD`. */
const tunedDay = (token: string, today: string): string | undefined => {
  const day = token.trim();
  const relative = /^([+-]\d+)$/.exec(day);
  if (relative) {
    return Temporal.PlainDate.from(today)
      .add({ days: Number(relative[1]) })
      .toString();
  }
  return /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : undefined;
};

const names = (text: string): ReadonlyArray<string> =>
  text
    .split(/\s*,\s*|\s+and\s+/)
    .map((name) => name.trim())
    .filter((name) => name !== '');

/**
 * The extras a turn names, comma-separated: `invite A and B`, `remove A`,
 * `remind N` (minutes), `note: text` (to the end), `due +N`,
 * `repeat weekly` / `repeat none`. Applied to the answer so far.
 */
const withExtras = (
  answer: Record<string, unknown>,
  text: string,
  today: string,
): Record<string, unknown> => {
  let next = { ...answer };
  let rest = text.trim();
  while (rest !== '') {
    const note = /^note:\s*(.*)$/is.exec(rest);
    if (note) {
      const said = (note[1] ?? '').trim();
      const notes = typeof next['notes'] === 'string' ? next['notes'] : '';
      next = { ...next, notes: notes === '' ? said : `${notes}\n${said}` };
      break;
    }
    const comma = rest.indexOf(',');
    const part = (comma === -1 ? rest : rest.slice(0, comma)).trim();
    rest = comma === -1 ? '' : rest.slice(comma + 1).trim();
    const invite = /^invite\s+(.+)$/i.exec(part);
    const remove = /^(?:remove|uninvite)\s+(.+)$/i.exec(part);
    const remind = /^remind\s+(\d+)$/i.exec(part);
    const due = /^due\s+([+-]\d+)$/i.exec(part);
    const repeat = /^repeat\s+(daily|weekly|monthly|yearly|none)$/i.exec(part);
    if (invite?.[1]) {
      // The rest of the turn, commas and all, names the people.
      next = { ...next, invite: names([invite[1], rest].filter(Boolean).join(', ')) };
      rest = '';
    } else if (remove?.[1]) {
      next = { ...next, uninvite: names([remove[1], rest].filter(Boolean).join(', ')) };
      rest = '';
    } else if (remind?.[1]) {
      const reminders = Array.isArray(next['reminders']) ? next['reminders'] : [];
      next = { ...next, reminders: [...reminders, Number(remind[1])] };
    } else if (due?.[1]) {
      const date = tunedDay(due[1], today);
      next = date ? { ...next, date } : next;
    } else if (repeat?.[1]) {
      const freq = repeat[1].toLowerCase();
      const { repeat: _old, ...without } = next;
      next = freq === 'none' ? without : { ...without, repeat: { freq } };
    }
  }
  return next;
};

/**
 * A `Title | +N | HH:MM-HH:MM | Location | extras` line laid over the
 * answer so far: an empty part leaves its field as it is.
 */
const withGrammar = (
  answer: Record<string, unknown>,
  line: string,
  today: string,
): Record<string, unknown> => {
  const [title = '', when = '', time = '', location = '', ...extras] = line
    .split('|')
    .map((part) => part.trim());
  const date = tunedDay(when, today);
  const range = TIME_RANGE.exec(time);
  const { endTime: _end, ...withoutEnd } = answer;
  const timed = range?.[1]
    ? { ...withoutEnd, startTime: range[1], ...(range[2] ? { endTime: range[2] } : {}) }
    : answer;
  return withExtras(
    {
      ...timed,
      ...(title ? { title } : {}),
      ...(date ? { date } : {}),
      ...(location ? { location } : {}),
    },
    extras.join('|'),
    today,
  );
};

/**
 * The tuned prompt (`tuned.ts`), answered the way the trained model
 * answers: the whole draft after the turn, written short. A first phrase
 * in the grammar makes an event (`todo:` in front makes a to-do); any
 * other phrase is a title on today. A later turn starts from the draft it
 * was shown, unchanged where the turn says nothing — the grammar line, or
 * one extra (`invite Tom`, `remind 60`, `note: …`, `due +0`,
 * `repeat weekly`).
 */
const tunedFixtureAnswer = (prompt: string): Record<string, unknown> => {
  const today = TUNED_TODAY.exec(prompt)?.[1];
  if (today === undefined) {
    throw new Error('fixture model: the tuned prompt names no day as today');
  }
  const draftLine = /^Draft: (.*)$/m.exec(prompt)?.[1];
  if (draftLine === undefined) {
    const phrase = textAfter(prompt, 'Phrase: ').trim();
    const task = /^todo:\s*/i.test(phrase);
    const words = phrase.replace(/^todo:\s*/i, '');
    const base = { date: today, kind: task ? 'task' : 'event', title: words };
    return words.includes('|') ? withGrammar(base, words, today) : base;
  }
  const draft = JSON.parse(draftLine) as Record<string, unknown>;
  const change = textAfter(prompt, 'Now: ').trim();
  return change.includes('|')
    ? withGrammar(draft, change, today)
    : withExtras(draft, change, today);
};

export const makeFixtureLanguageModel = (): LanguageModel => ({
  generateJson: async ({ jsonSchema, prompt }) => {
    // The tuned path asks without a schema.
    if (jsonSchema === undefined && prompt.startsWith('Calendar entry as JSON')) {
      return tunedFixtureAnswer(prompt);
    }
    const properties = isRecord(jsonSchema) ? jsonSchema.properties : undefined;
    const referenceDate = referenceDateOf(prompt);
    if (isRecord(properties) && 'events' in properties) {
      const events = textAfter(prompt, CAPTURE_TEXT_MARKER)
        .split('\n')
        .map((line) => parseLine(line, referenceDate))
        .filter((item): item is CaptureItemParse => item !== undefined);
      return { events } satisfies CaptureParse;
    }
    if (isRecord(properties) && 'terms' in properties) {
      const currentLine = textAfter(prompt, SEARCH_QUERY_CURRENT_MARKER).split('\n')[0] ?? '{}';
      const current = JSON.parse(currentLine) as SearchQueryParse;
      const phrase = textAfter(prompt, SEARCH_QUERY_PHRASE_MARKER).trim();
      return searchTurn(current, phrase, referenceDate);
    }
    if (isRecord(properties) && 'windowStartDate' in properties) {
      const title = textAfter(prompt, FIND_TIME_PHRASE_MARKER).split('|')[1]?.trim();
      return { durationMinutes: 60, ...(title ? { title } : {}) } satisfies FindTimeParse;
    }
    throw new Error('fixture model: unsupported schema');
  },
  status: async () => 'ready',
});

/**
 * "Recognises" an image whose bytes are UTF-8 text — a spec pastes a text
 * file as an image and the whole image path runs without Vision.
 */
export const fixtureTextRecognizer: TextRecognizer = {
  recognizeText: async (image: ImageInput) => {
    if (image.kind !== 'base64') {
      throw new TextRecognitionError({ message: 'The fixture recognizer reads base64 only.' });
    }
    try {
      const bytes = Uint8Array.from(atob(image.base64), (char) => char.charCodeAt(0));
      return new TextDecoder().decode(bytes);
    } catch {
      throw new TextRecognitionError({ message: 'Not base64.' });
    }
  },
};
