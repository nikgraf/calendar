import {
  LESSON_CREATE_PHRASE,
  LESSON_SEARCH_PHRASE,
  type LessonId,
  Temporal,
} from '@calendar/core';
import { router } from 'expo-router';
import type { EditorHost } from './EditorHost.tsx';

/** How long the Settings modal takes to slide away before another sheet can present. */
const SETTINGS_DISMISS_MS = 500;

/** The route of a lesson that is a page of its own (`app/lesson/`). */
const LESSON_PATHS = {
  alerts: '/lesson/alerts',
  contacts: '/lesson/contacts',
  otherDevice: '/lesson/other-device',
  zones: '/lesson/zones',
} as const;

/**
 * Opens a Getting started lesson: Create with AI is the editor on today
 * with the phrase in its quick-add field; Search with AI is the Search
 * tab with its sentence read; the rest are pages of their own, over
 * whatever is up. From Settings, the calendar's sheets wait for the
 * modal to slide away first — the editor and Settings are both routes
 * over the tabs, and one presents at a time.
 */
export const openLesson = (
  id: LessonId,
  host: EditorHost,
  { from, timeZone }: { readonly from: 'calendar' | 'settings'; readonly timeZone: string },
): void => {
  const leaveSettings = (then: () => void) => {
    if (from === 'settings') {
      router.dismissTo('/');
      setTimeout(then, SETTINGS_DISMISS_MS);
    } else {
      then();
    }
  };
  switch (id) {
    case 'create':
      leaveSettings(() =>
        host.editEvent({
          initialDate: Temporal.Now.plainDateISO(timeZone),
          initialHour: 12,
          lesson: 'create',
          quickAddText: LESSON_CREATE_PHRASE,
        }),
      );
      return;
    case 'search':
      leaveSettings(() =>
        router.navigate({
          params: { lesson: '1', phrase: LESSON_SEARCH_PHRASE },
          pathname: '/search',
        }),
      );
      return;
    default:
      router.push(LESSON_PATHS[id]);
  }
};
