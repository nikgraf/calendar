import type { RecurringScope } from '@calendar/core';

/**
 * What a delete asks before it runs, naming what goes. A delete used to be
 * one tap with nothing to undo it: "All events" removed a whole series,
 * and an Apple delete is gone from EventKit at once. `scope` is given for
 * an occurrence of a series.
 */
export const deleteQuestion = (title: string, scope?: RecurringScope): string => {
  const name = `“${title.trim()}”`;
  switch (scope) {
    case 'instance':
      return `Delete this occurrence of ${name}?`;
    case 'following':
      return `Delete ${name} from this occurrence on?`;
    case 'series':
      return `Delete every occurrence of ${name}?`;
    case undefined:
      return `Delete ${name}?`;
  }
};
