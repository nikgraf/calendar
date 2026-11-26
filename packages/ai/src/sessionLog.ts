import type { QuickAddResult } from './normalizeQuickAdd.ts';
import type { Heard } from './speech.ts';

/**
 * The Assistant's session log: what one thread of the editor's Assistant
 * was told, what it made of that and how the thread ended, kept on the
 * device while Keep Assistant Sessions is on (off unless switched on).
 * The draft thread (app-state) writes one record when its editor closes;
 * each app keeps them as lines of one file, the newest last and at most
 * `SESSION_LOG_CAP` of them, and hands that file out on Export. No audio
 * is in it: the recognisers' text is. The bench reads an export
 * (`apps/desktop/e2e/bench/sessions.ts`).
 *
 * The shape is the export's format: a change that old lines would not
 * read as moves `SESSION_LOG_VERSION`, and `parseSessions` skips the
 * lines of another version.
 */

export const SESSION_LOG_VERSION = 1;

/** Threads kept: the oldest goes when another comes. */
export const SESSION_LOG_CAP = 200;

/** A place a turn's location text could mean, as it was offered. */
export interface SessionCandidate {
  readonly address?: string | undefined;
  /** The other reading of the dictated words it was found for. */
  readonly alternative?: string | undefined;
  readonly match: 'exact' | 'phonetic' | 'search' | 'words';
  /** The text the location field takes when it is picked. */
  readonly name: string;
  readonly source: 'history' | 'mapkit';
}

/** What a turn's location text could mean. */
export interface SessionPlace {
  readonly candidates: ReadonlyArray<SessionCandidate>;
  /** The candidate taken unasked, by its place among them; none: the text stayed as said. */
  readonly taken?: number | undefined;
  /** The location text the turn set. */
  readonly text: string;
}

/** A name a turn invited, and what the contacts gave for it. */
export interface SessionInvitee {
  /** The contacts it could be, where it named no one person; empty: nobody by that name. */
  readonly choices?: ReadonlyArray<string> | undefined;
  readonly name: string;
  /** The one contact it named, taken as a guest. */
  readonly taken?: string | undefined;
}

/** One question to the model: what it was asked, what it wrote, what the reader made of it. */
export interface SessionRead {
  /** The model's answer before any code read it; none when it gave no JSON. */
  readonly answer?: unknown;
  /** The prompt, whole: the days, the draft as shown, what was said before, the words. */
  readonly prompt?: string | undefined;
  /** The reader's result: a draft, or its refusal. None when the model could not be asked. */
  readonly result?: QuickAddResult | undefined;
}

/** Another reading of dictated words that changed nothing, as it was offered. */
export interface SessionReading {
  readonly does: string;
  readonly text: string;
}

/**
 * What became of a turn: it made or changed a draft (`changed`, the
 * thread's own summary of the step), left every draft as it was
 * (`no-change`), was answered with a message instead (`refused`: the
 * reader's refusal, or what the item cannot hold), found the model
 * unable to answer (`failed`), or was let go of before it landed
 * (`dropped`: the phrase grew and was read again, or the thread moved on).
 */
export type SessionOutcome =
  | { readonly kind: 'changed'; readonly summary: string }
  | { readonly kind: 'dropped' }
  | { readonly kind: 'failed' }
  | { readonly kind: 'no-change'; readonly note?: string | undefined }
  | { readonly kind: 'refused'; readonly message: string };

/** One phrase said or typed to the thread. */
export interface SessionTurn {
  /** When it was sent, as an instant. */
  readonly at: string;
  /** The day it was read on, in the thread's time zone. */
  readonly day: string;
  /** Free slots found, for a phrase that asked for free time. */
  readonly freeSlots?: number | undefined;
  /** A dictated phrase as the recognisers read it, whole: segments, alternatives, the other readings. */
  readonly heard?: Heard | undefined;
  /**
   * `dictated`: the words came from the recognisers (`heard`). `typed`:
   * they came without a reading: typed, or another reading that was
   * offered and tapped.
   */
  readonly input: 'dictated' | 'typed';
  /** The names it invited, each with what the contacts gave. */
  readonly invited?: ReadonlyArray<SessionInvitee> | undefined;
  readonly outcome: SessionOutcome;
  /** A dictated phrase: Parakeet's reading was the one sent. */
  readonly parakeet?: boolean | undefined;
  readonly place?: SessionPlace | undefined;
  /** Other readings offered under a dictated phrase that changed nothing. */
  readonly readings?: ReadonlyArray<SessionReading> | undefined;
  /** The model's part: one read per draft the words were said to. */
  readonly reads: ReadonlyArray<SessionRead>;
  /** `first`: it made the draft; `change`: it changed one; `finder`: it asked for free time. */
  readonly route: 'change' | 'finder' | 'first';
  /** The words as sent. */
  readonly text: string;
  /** Taken back afterwards (Undo, or an older step kept): its step is not in the thread as it ended. */
  readonly undone?: boolean | undefined;
  /** The names it took off the guest list, as said. */
  readonly uninvited?: ReadonlyArray<string> | undefined;
}

/** A choice the thread offered, answered by hand. `after`: the turn before it, by its place (-1: none). */
export type SessionPick =
  | {
      readonly after: number;
      /** The contact picked. */
      readonly contact: string;
      readonly kind: 'guest';
      /** The name it answered, as said. */
      readonly name: string;
    }
  | {
      readonly after: number;
      /** The candidate picked, by its place among the turn's; none: the text kept as said. */
      readonly candidate?: number | undefined;
      readonly kind: 'place';
    }
  | { readonly after: number; readonly kind: 'slot' };

/** An item as it was written. */
export interface SessionSaved {
  /** The day it is on; none for a to-do without a due day. */
  readonly date?: string | undefined;
  /**
   * The parts that read otherwise than the last phrase left them: what
   * was changed by hand, a pick among them.
   */
  readonly edited: ReadonlyArray<string>;
  readonly endDate?: string | undefined;
  readonly endTime?: string | undefined;
  readonly guests: number;
  readonly isAllDay?: boolean | undefined;
  readonly kind: 'event' | 'task';
  readonly location?: string | undefined;
  /** An event's rule as the form holds it; a to-do's by its frequency. */
  readonly repeat?: Readonly<Record<string, unknown>> | undefined;
  readonly startTime?: string | undefined;
  readonly title: string;
}

/** What every record says of the app that wrote it. */
export interface SessionAbout {
  readonly app: { readonly platform: 'iPhone' | 'Mac'; readonly version: string };
  /** The Assistant's model: its release, or what stood in for it (`fixture`). */
  readonly model: string;
}

/** One thread of the Assistant, from its first phrase to its editor closing. */
export interface AssistantSession extends SessionAbout {
  readonly endedAt: string;
  readonly id: string;
  /** Drafts not written when the editor closed. */
  readonly left: number;
  /** What the thread began as: a new item, a saved one opened, or a capture's drafts. */
  readonly origin: 'capture' | 'new' | 'saved';
  readonly picks: ReadonlyArray<SessionPick>;
  /** The items written, in order. None: the thread was abandoned. */
  readonly saved: ReadonlyArray<SessionSaved>;
  readonly startedAt: string;
  readonly timeZone: string;
  readonly turns: ReadonlyArray<SessionTurn>;
  readonly v: typeof SESSION_LOG_VERSION;
}

/**
 * Where a thread's record goes, per platform: whether sessions are kept
 * now (the switch), what the app says of itself, and the store.
 */
export interface SessionSink {
  readonly about: () => SessionAbout;
  /** Kept on the device, nothing else: a failed write is the store's to swallow. */
  readonly keep: (session: AssistantSession) => void;
  readonly on: () => boolean;
}

const lines = (text: string): ReadonlyArray<string> =>
  text.split('\n').filter((line) => line.trim() !== '');

/** How many sessions a log's text holds. */
export const sessionCount = (text: string): number => lines(text).length;

/**
 * The log with a session added, as the file's text: one JSON line per
 * session, the newest last, the oldest dropped past `cap`. The lines
 * already there are kept as they are, unread: an older version's stay
 * until they age out.
 */
export const appendSession = (
  text: string,
  session: AssistantSession,
  cap: number = SESSION_LOG_CAP,
): string => {
  const kept = [...lines(text), JSON.stringify(session)].slice(-Math.max(cap, 1));
  return `${kept.join('\n')}\n`;
};

const isSession = (value: unknown): value is AssistantSession =>
  typeof value === 'object' &&
  value !== null &&
  (value as { v?: unknown }).v === SESSION_LOG_VERSION &&
  typeof (value as { id?: unknown }).id === 'string' &&
  Array.isArray((value as { turns?: unknown }).turns) &&
  Array.isArray((value as { saved?: unknown }).saved);

/**
 * The sessions a log's text holds, oldest first. A line that is no JSON
 * (a write cut short) or no session of this version is left out and
 * counted, so a reader can say how much it could not read.
 */
export const parseSessions = (
  text: string,
): { readonly sessions: ReadonlyArray<AssistantSession>; readonly skipped: number } => {
  const sessions: Array<AssistantSession> = [];
  let skipped = 0;
  for (const line of lines(text)) {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      value = undefined;
    }
    if (isSession(value)) {
      sessions.push(value);
    } else {
      skipped += 1;
    }
  }
  return { sessions, skipped };
};

/** An export's file name: `solunivo-assistant-sessions-2026-11-26.jsonl`. */
export const sessionExportName = (day: string): string =>
  `solunivo-assistant-sessions-${day}.jsonl`;

/** "No sessions kept", "1 session kept", "12 sessions kept": the row beside Export. */
export const sessionCountLabel = (count: number): string =>
  count === 0
    ? 'No sessions kept'
    : `${String(count)} ${count === 1 ? 'session' : 'sessions'} kept`;

/**
 * What Keep Assistant Sessions says it keeps, under the switch on both
 * apps. Each part is in the record (`AssistantSession`); PRIVACY.md says
 * the same.
 */
export const sessionLogCopy = (device: 'iPhone' | 'Mac'): string =>
  `Keeps your last ${String(SESSION_LOG_CAP)} conversations with the Assistant on this ${device}, to find where it goes wrong: what you typed or dictated as the recognisers read it, what the model answered, the places and contacts it found, and what you saved, changed by hand or left. No audio. Nothing is sent anywhere; Export hands you the file, and it holds the names and places you said.`;
