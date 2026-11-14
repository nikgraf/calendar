import { LESSON_CREATE_CHANGE, LESSON_CREATE_PHRASE } from '@calendar/core';
import type { LanguageModel } from './model.ts';
import { TUNED_CHANGE_MARKER, TUNED_DRAFT_MARKER, TUNED_PHRASE_MARKER } from './tuned.ts';

/**
 * The Create lesson's demo, while the Assistant's model is not on the
 * device (not asked for yet, downloading, or a device that cannot run
 * it): a stand-in for the model that knows the lesson's two phrases and
 * nothing else. Its answers are the ones model v2 gave to them, kept in
 * the app, so the real editor turns them into the real card, the form
 * and Save as it would the model's (recorded 2026-11-14 on three days,
 * through `llama-server` as the Mac asks it). Two things are written so
 * they hold on any day: the day v2 looked up for "tomorrow" in the days
 * it is shown, as a count from today ("+1d", worked out by `said.ts`);
 * and the change as the draft it is shown with the new hours and without
 * its date, which is all v2 changed (the change names no day, so the
 * draft keeps its own; the reminders and the rest it wrote back as shown).
 */

/** v2's answer to `LESSON_CREATE_PHRASE`: no end, which the form gives an hour. */
export const LESSON_DEMO_FIRST = {
  date: '+1d',
  kind: 'event',
  location: 'Mercato',
  startTime: '12:30',
  title: 'Lunch with Sam',
} as const;

/** The hours v2 gave the draft for `LESSON_CREATE_CHANGE`. */
export const LESSON_DEMO_CHANGE = { endTime: '14:00', startTime: '13:00' } as const;

/** Why anything else is refused: only the model reads other words. */
export const LESSON_DEMO_ONLY = 'The demo answers the lesson’s phrases only.';

/** The text of the line a prompt starts with `marker`, if it has one. */
const lineAfter = (prompt: string, marker: string): string | undefined =>
  prompt
    .split('\n')
    .find((line) => line.startsWith(marker))
    ?.slice(marker.length);

const draftOf = (line: string | undefined): Record<string, unknown> | undefined => {
  if (line === undefined) {
    return undefined;
  }
  try {
    const draft: unknown = JSON.parse(line);
    return typeof draft === 'object' && draft !== null && !Array.isArray(draft)
      ? (draft as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
};

/** The demo as a `LanguageModel` for the tuned reader (`tunedReader(lessonDemoModel)`). */
export const lessonDemoModel: LanguageModel = {
  generateJson: async ({ prompt }) => {
    if (lineAfter(prompt, TUNED_PHRASE_MARKER) === LESSON_CREATE_PHRASE) {
      return { ...LESSON_DEMO_FIRST };
    }
    const draft = draftOf(lineAfter(prompt, TUNED_DRAFT_MARKER));
    if (lineAfter(prompt, TUNED_CHANGE_MARKER) === LESSON_CREATE_CHANGE && draft !== undefined) {
      // No day was said, so the answer has none: the draft keeps its own.
      return {
        ...Object.fromEntries(Object.entries(draft).filter(([key]) => key !== 'date')),
        ...LESSON_DEMO_CHANGE,
      };
    }
    throw new Error(LESSON_DEMO_ONLY);
  },
  status: async () => 'ready',
};
