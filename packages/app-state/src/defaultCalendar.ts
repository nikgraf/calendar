import {
  type Account,
  type CalendarInfo,
  isCalendarWritable,
  type MirrorCalendarRef,
  mirrorRefKey,
  portableCalendarRef,
} from '@calendar/core';
import { calendarGroups } from './editorModel.ts';

/** A calendar Settings offers as the default: one that takes new events here. */
export interface DefaultCalendarChoice {
  /**
   * Another calendar here has the same EventKit source and title. The
   * setting names Apple calendars by those two, so neither can be told
   * apart from the other: offered, but not to be picked.
   */
  readonly ambiguous: boolean;
  readonly calendar: CalendarInfo;
  /** `accountId:calendarId`, as the editor names its calendar. */
  readonly key: string;
  readonly ref: MirrorCalendarRef;
}

/** Every writable calendar here, in the order the editor's picker lists them. */
export const defaultCalendarChoices = (
  accounts: ReadonlyArray<Account>,
  calendars: ReadonlyArray<CalendarInfo>,
): ReadonlyArray<DefaultCalendarChoice> => {
  const named = calendars.flatMap((calendar) => {
    const account = accounts.find((entry) => entry.id === calendar.accountId);
    const ref =
      account && isCalendarWritable(calendar) ? portableCalendarRef(calendar, account) : undefined;
    return ref ? [{ calendar, ref }] : [];
  });
  const counts = new Map<string, number>();
  for (const { ref } of named) {
    counts.set(mirrorRefKey(ref), (counts.get(mirrorRefKey(ref)) ?? 0) + 1);
  }
  return named.map(({ calendar, ref }) => ({
    ambiguous: (counts.get(mirrorRefKey(ref)) ?? 0) > 1,
    calendar,
    key: `${calendar.accountId}:${calendar.id}`,
    ref,
  }));
};

/** The choices bucketed like the editor's picker (`labelOf` names a bucket, per platform). */
export const defaultCalendarGroups = (
  choices: ReadonlyArray<DefaultCalendarChoice>,
  labelOf: (calendar: CalendarInfo) => string,
): ReadonlyArray<{
  readonly choices: ReadonlyArray<DefaultCalendarChoice>;
  readonly label: string;
}> => {
  const byKey = new Map(choices.map((choice) => [choice.key, choice]));
  return calendarGroups(
    choices.map((choice) => choice.calendar),
    labelOf,
  ).map((group) => ({
    choices: group.calendars.flatMap((calendar) => {
      const choice = byKey.get(`${calendar.accountId}:${calendar.id}`);
      return choice ? [choice] : [];
    }),
    label: group.label,
  }));
};
