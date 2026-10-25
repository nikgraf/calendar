import { Temporal } from '@calendar/core';
import { CAPTURE_TEXT_MARKER, type CaptureItemParse, type CaptureParse } from './capture.ts';
import { FIND_TIME_PHRASE_MARKER, type FindTimeParse } from './findTime.ts';
import { PEOPLE_SENTENCE_MARKER, type PeopleParse } from './invitees.ts';
import type { LanguageModel } from './model.ts';
import {
  SEARCH_QUERY_CURRENT_MARKER,
  SEARCH_QUERY_PHRASE_MARKER,
  type SearchQueryParse,
} from './searchQuery.ts';
import { QUICK_ADD_PHRASE_MARKER, type QuickAddParse } from './quickAdd.ts';
import { REFINE_CHANGE_MARKER, REFINE_CURRENT_MARKER } from './refine.ts';
import { TextRecognitionError, type ImageInput, type TextRecognizer } from './textRecognition.ts';

/**
 * A stand-in for the on-device model that both e2e suites can run on any
 * machine. It does no language work: the input is written in a tiny
 * grammar, one event per line —
 *
 *     Title | +N or YYYY-MM-DD | HH:MM-HH:MM | Location
 *
 * — and `+N` counts days from the prompt's "Today is" line, so a spec
 * never computes a date. A quick-add phrase in the same grammar yields one
 * event; any other phrase becomes a title on its own, which the normalizer
 * places on the fallback day as an all-day event — unless the phrase's own
 * words say otherwise, which the normalizer reads the same way for every
 * model ("Lunch tomorrow at 1" lands tomorrow at 13:00, titled "Lunch"). A refinement is
 * the same grammar with empty parts meaning "unchanged" — `| | 10:00-11:00`
 * moves the times only — applied to the draft in the prompt; a sentence
 * leaves the draft as it is, and the normalizer reads the sentence. A
 * finder sentence (`find 30 min tomorrow morning | Focus`) answers with
 * the title after the bar and an hour; the normalizer reads the length,
 * the window and the hours from the sentence itself, as for every model.
 * A search turn is `terms | from..to | location | people | calendar |
 * kind` — days as `+N`, `-N` or ISO, a single day alone, people and
 * calendars comma-separated, kind `tasks` or `events` — applied to the
 * current filters, an empty part unchanged; a sentence without a bar
 * replaces the words only. Asked who a phrase invites, it names the
 * people after "invite", "uninvite" or "remove" — to the end, split at
 * commas and "and" (`… tomorrow at 1, invite Tom Baker and Anna`); the
 * code decides from the words what they are.
 */

const TODAY = /Today is (\d{4}-\d{2}-\d{2})/;
const RELATIVE_DAY = /^\+(\d+)$/;
const TIME_RANGE = /^(\d{2}:\d{2})(?:-(\d{2}:\d{2}))?$/;

/** The tail that names people: what a model would read as the people to invite or take off. */
const PEOPLE_TAIL = /\b(?:(?:un)?invite|remove)\s+(.+)$/i;

const peopleOf = (phrase: string): ReadonlyArray<string> =>
  (PEOPLE_TAIL.exec(phrase)?.[1] ?? '')
    .split(/\s*,\s*|\s+and\s+/)
    .map((name) => name.trim())
    .filter((name) => name !== '');

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

export const makeFixtureLanguageModel = (): LanguageModel => ({
  generateJson: async ({ jsonSchema, prompt }) => {
    const properties = isRecord(jsonSchema) ? jsonSchema.properties : undefined;
    // Who a phrase invites: the one question without a reference date.
    if (isRecord(properties) && 'people' in properties && !('terms' in properties)) {
      return {
        people: peopleOf(textAfter(prompt, PEOPLE_SENTENCE_MARKER).trim()),
      } satisfies PeopleParse;
    }
    const referenceDate = referenceDateOf(prompt);
    if (isRecord(properties) && 'events' in properties) {
      const events = textAfter(prompt, CAPTURE_TEXT_MARKER)
        .split('\n')
        .map((line) => parseLine(line, referenceDate))
        .filter((item): item is CaptureItemParse => item !== undefined);
      return { events } satisfies CaptureParse;
    }
    if (
      isRecord(properties) &&
      'startTime' in properties &&
      prompt.includes(REFINE_CHANGE_MARKER)
    ) {
      const currentLine = textAfter(prompt, REFINE_CURRENT_MARKER).split('\n')[0] ?? '{}';
      const current = JSON.parse(currentLine) as QuickAddParse;
      const change = textAfter(prompt, REFINE_CHANGE_MARKER).trim();
      if (!change.includes('|')) {
        return current;
      }
      const [title = '', when = '', time = '', location = ''] = change
        .split('|')
        .map((part) => part.trim());
      const parsed = parseLine(
        `${title || current.title} | ${when} | ${time} | ${location}`,
        referenceDate,
      );
      return {
        ...current,
        ...(title ? { title } : {}),
        ...(parsed?.date ? { date: parsed.date } : {}),
        ...(parsed?.startTime
          ? { endTime: parsed.endTime, isAllDay: false, startTime: parsed.startTime }
          : {}),
        ...(location ? { location } : {}),
      };
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
    if (isRecord(properties) && 'startTime' in properties) {
      const full = textAfter(prompt, QUICK_ADD_PHRASE_MARKER).trim();
      // "todo: …" is the fixture's to-do marker: the normalizer reads the
      // cue itself, so the fixture only keeps it out of the title.
      const phrase = full.replace(/^todo:\s*/i, '');
      const parsed: QuickAddParse = (phrase.includes('|')
        ? parseLine(phrase, referenceDate)
        : undefined) ?? { title: phrase };
      return parsed;
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
