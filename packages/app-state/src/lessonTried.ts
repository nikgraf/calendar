import { createContext, useContext } from 'react';

/**
 * A lesson's frame listens for the first thing tried inside it — a
 * setting saved, an access allowed — to tick the lesson as done rather
 * than skipped. The settings sections both apps reuse call `tried()`
 * after a successful change; outside a lesson there is no listener, and
 * the call is nothing.
 */
export const LessonTriedContext = createContext<(() => void) | null>(null);

const nothing = (): void => {};

/** What a section calls once something in it went through. */
export const useLessonTried = (): (() => void) => useContext(LessonTriedContext) ?? nothing;

/** Whether the section is inside a lesson's frame (some sections add a first step there). */
export const useInLesson = (): boolean => useContext(LessonTriedContext) !== null;
