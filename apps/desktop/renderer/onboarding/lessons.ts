import { LESSON_IDS, type LessonId } from '@calendar/core';

/** A lesson id as it crosses IPC (`lesson:open`): one of the six, or null. */
export const parseLessonId = (value: unknown): LessonId | null =>
  typeof value === 'string' && (LESSON_IDS as ReadonlyArray<string>).includes(value)
    ? (value as LessonId)
    : null;
