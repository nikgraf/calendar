import { Temporal } from '@calendar/core';
import { normalizeQuickAdd, type QuickAddPrefill } from './normalizeQuickAdd.ts';
import { QUICK_ADD_JSON_SCHEMA, type QuickAddParse } from './quickAdd.ts';
import { realDate, upcomingDays } from './shared.ts';

/**
 * Capture: a pasted email or the text read off a screenshot in, every event
 * it describes out. The quick-add item shape is reused minus recurrence —
 * a poster lists dates, it rarely states a repeat rule, and a small model
 * invents one readily.
 */

/** One extracted event; the quick-add fields without a repeat. */
export type CaptureItemParse = Omit<QuickAddParse, 'recurrence'>;

/** What the model is asked to extract from a text. */
export interface CaptureParse {
  readonly events?: ReadonlyArray<CaptureItemParse>;
}

/**
 * Characters of source text the model is given. The OS 26 on-device model
 * has a ~4k-token context that prompt, text and answer share; 6000 chars of
 * prose is roughly 1500 tokens, which leaves room for eight events.
 */
export const MAX_CAPTURE_TEXT_CHARS = 6000;
/** Events per capture; more than this is a schedule, not an email. */
export const MAX_CAPTURE_EVENTS = 8;
/** Longest token kept whole; tracking URLs and base64 junk are clipped. */
const MAX_TOKEN_CHARS = 60;
/**
 * What a long token has to look like to be clipped: a URL, or a run of
 * ASCII word characters (base64, a tracking id). Prose without spaces —
 * a Japanese or Chinese paragraph is one "token" — is left whole.
 */
const CLIPPABLE_TOKEN = /^(?:https?:\/\/|www\.)|[A-Za-z0-9+/=_%&?.~:#-]{60,}/;
/** The line the source text follows in the prompt; the fixture model keys on it. */
export const CAPTURE_TEXT_MARKER = 'Text:\n';

const { date, endTime, isAllDay, location, startTime, title } = QUICK_ADD_JSON_SCHEMA.properties;

/** Guided-generation schema; kept in sync with CaptureParse by hand. */
export const CAPTURE_JSON_SCHEMA = {
  additionalProperties: false,
  properties: {
    events: {
      items: {
        additionalProperties: false,
        properties: { date, endTime, isAllDay, location, startTime, title },
        required: ['date', 'title'],
        type: 'object',
      },
      maxItems: MAX_CAPTURE_EVENTS,
      type: 'array',
    },
  },
  required: ['events'],
  type: 'object',
} as const;

/**
 * Where a quoted reply starts. Everything from the first such line on is
 * someone else's earlier mail, which usually repeats the same event with
 * the dates it had before they changed.
 */
const QUOTED_REPLY = [
  /^>/,
  /^On .+ wrote:$/,
  /^Am .+ schrieb.*:$/,
  /^-{2,}\s*Original Message\s*-{2,}$/i,
  /^_{10,}$/,
];

/**
 * Makes pasted or recognised text fit the model: one kind of newline, no
 * runs of blanks, quoted replies cut, over-long tokens clipped, and a hard
 * cap at a line boundary. Deterministic on purpose — what the model sees
 * is reproducible from what the user pasted.
 */
export const prepareCaptureText = (raw: string): { text: string; truncated: boolean } => {
  const lines = raw
    .replaceAll(/\r\n?/g, '\n')
    .replaceAll(/[ ​⁠﻿]/g, ' ')
    .split('\n')
    .map((line) =>
      line
        .trim()
        .split(/[ \t]+/)
        .map((token) =>
          token.length > MAX_TOKEN_CHARS && CLIPPABLE_TOKEN.test(token)
            ? `${token.slice(0, MAX_TOKEN_CHARS)}…`
            : token,
        )
        .join(' '),
    );
  // A message that opens with the marker is itself the quoted mail (a
  // forward); only a marker after some unquoted content cuts.
  let sawContent = false;
  let cutAt = -1;
  for (const [index, line] of lines.entries()) {
    const isMarker = QUOTED_REPLY.some((marker) => marker.test(line));
    if (isMarker && sawContent) {
      cutAt = index;
      break;
    }
    sawContent ||= line.length > 0 && !isMarker;
  }
  const kept = (cutAt === -1 ? lines : lines.slice(0, cutAt)).join('\n');
  const text = kept.replaceAll(/\n{3,}/g, '\n\n').trim();
  if (text.length <= MAX_CAPTURE_TEXT_CHARS) {
    return { text, truncated: false };
  }
  const head = text.slice(0, MAX_CAPTURE_TEXT_CHARS);
  const lastBreak = head.lastIndexOf('\n');
  return { text: (lastBreak > 0 ? head.slice(0, lastBreak) : head).trim(), truncated: true };
};

export const buildCapturePrompt = ({
  referenceDate,
  text,
  timeZone,
}: {
  /** `YYYY-MM-DD` — "today" from the user's point of view. */
  referenceDate: string;
  text: string;
  timeZone: string;
}): string =>
  [
    'List every calendar event the text describes — a meeting, a show, a',
    'deadline, a trip. Skip events that already happened and are only being',
    'referred to.',
    `Today is ${referenceDate} in time zone ${timeZone}.`,
    'Each event needs a title and a date as YYYY-MM-DD. Write dates the text',
    'states; a date without a year is the next time it occurs. Resolve',
    'relative words ("tomorrow", "next Tuesday") by picking from this list,',
    `never by computing: ${upcomingDays(referenceDate)}.`,
    'Use 24-hour HH:MM times: 1pm is 13:00, 12pm is 12:00, midnight is 00:00.',
    'Omit fields the text does not state — never invent a location or a time,',
    'and never write placeholders like "unknown". The title is only what the',
    'event is, without its date, time or place, in the original language.',
    `${CAPTURE_TEXT_MARKER}${text}`,
  ].join('\n');

/** How far in the past a date may lie before an unstated year is read as "next year". */
const PAST_GRACE_DAYS = 30;

/**
 * "Oct 14" written in September means next month, but a small model given
 * today's year writes it into the year it knows; written in November it
 * means next year. Only a year the text spells out is trusted — otherwise a
 * date well in the past moves forward one year.
 */
export const resolveUnstatedYear = (
  isoDate: string,
  { referenceDate, sourceText }: { referenceDate: string; sourceText: string },
): string => {
  const parsed = Temporal.PlainDate.from(isoDate);
  if (sourceText.includes(String(parsed.year))) {
    return isoDate;
  }
  const daysPast = Temporal.PlainDate.from(referenceDate).since(parsed).total({ unit: 'days' });
  return daysPast > PAST_GRACE_DAYS ? parsed.add({ years: 1 }).toString() : isoDate;
};

/**
 * Validates every extracted item the way quick-add validates its one, then
 * drops undated items (a date is what makes a capture an event — nothing
 * is placed on today by default), duplicates and anything past the cap.
 */
export const normalizeCapture = (
  parse: CaptureParse,
  {
    referenceDate,
    sourceText,
    timeZone,
  }: { referenceDate: string; sourceText: string; timeZone: string },
): ReadonlyArray<QuickAddPrefill> => {
  const items = Array.isArray(parse.events) ? parse.events : [];
  const seen = new Set<string>();
  const drafts: Array<QuickAddPrefill> = [];
  for (const item of items) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const itemDate = realDate(typeof item.date === 'string' ? item.date.trim() : undefined);
    if (!itemDate) {
      continue;
    }
    const result = normalizeQuickAdd(
      { ...item, date: resolveUnstatedYear(itemDate, { referenceDate, sourceText }) },
      { referenceDate, timeZone },
    );
    if (result.kind !== 'parsed') {
      continue;
    }
    const { prefill } = result;
    const key = `${prefill.title.toLowerCase()}|${prefill.date}|${prefill.startTime}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    drafts.push(prefill);
  }
  drafts.sort(
    (left, right) =>
      Temporal.PlainDate.compare(left.date, right.date) ||
      left.startTime.localeCompare(right.startTime) ||
      left.title.localeCompare(right.title),
  );
  return drafts.slice(0, MAX_CAPTURE_EVENTS);
};
