import {
  buildEventTimes,
  buildRecurrenceRule,
  byDayError,
  type EventDraft,
  expandRecurringEvent,
  GeoLocation,
  geoMatches,
  repeatUntilError,
  validateEventDraft,
} from '@calendar/core';
import type { Draft, DraftExtras } from './draftThread.ts';
import type { EventEditorPrefill } from './editorModel.ts';
import { repeatSpecFrom, seedRepeatFields } from './repeatState.ts';

/**
 * What the calendar draws for the thread's drafts: each event draft as a
 * block in its calendar's color, every occurrence of a repeating one in
 * the visible range, the focused one marked. Nothing here is stored —
 * the previews are derived from the drafts (and the live form for the
 * focused one) on every change.
 */

export interface DraftPreview {
  /** The hex of the calendar the draft would be created in. */
  readonly color: string;
  readonly date: string;
  readonly endTime: string;
  readonly focused: boolean;
  readonly id: string;
  readonly isAllDay: boolean;
  /** The RRULE line the save would write, when the draft repeats. */
  readonly recurrence?: ReadonlyArray<string> | undefined;
  readonly startTime: string;
  readonly title: string;
}

/** One block to draw: a draft, or one occurrence of a repeating draft. */
export interface DraftOccurrence {
  readonly color: string;
  readonly draftId: string;
  readonly endDate?: string | undefined;
  readonly endTime: string;
  readonly endUtc: number;
  readonly focused: boolean;
  readonly isAllDay: boolean;
  /** Unique within the strip: the draft's id, and the occurrence's start for a repeat. */
  readonly key: string;
  readonly startDate?: string | undefined;
  readonly startTime: string;
  readonly startUtc: number;
  readonly title: string;
}

/** The RRULE a prefill's repeat fields build, the way Save builds it. */
export const prefillRecurrence = (
  prefill: EventEditorPrefill,
  timeZone: string,
): ReadonlyArray<string> | undefined => {
  const spec = repeatSpecFrom(seedRepeatFields(prefill.recurrence), prefill.date);
  return spec ? [buildRecurrenceRule(spec, prefill.isAllDay, timeZone)] : undefined;
};

/** A draft's preview; a to-do draws no block (it has no span on the grid yet). */
export const draftPreview = (
  draft: Draft,
  { color, focused, timeZone }: { color: string; focused: boolean; timeZone: string },
): DraftPreview | undefined =>
  draft.item.kind === 'event'
    ? previewOfPrefill(draft.id, draft.item.prefill, { color, focused, timeZone })
    : undefined;

export const previewOfPrefill = (
  id: string,
  prefill: EventEditorPrefill,
  { color, focused, timeZone }: { color: string; focused: boolean; timeZone: string },
): DraftPreview => ({
  color,
  date: prefill.date,
  endTime: prefill.endTime,
  focused,
  id,
  isAllDay: prefill.isAllDay,
  recurrence: prefillRecurrence(prefill, timeZone),
  startTime: prefill.startTime,
  title: prefill.title,
});

/**
 * The blocks to draw for a range: a draft once, a repeating draft at every
 * occurrence the range holds (through the same expander the grid uses for
 * stored series).
 */
export const draftOccurrences = (
  previews: ReadonlyArray<DraftPreview>,
  rangeStartUtc: number,
  rangeEndUtc: number,
  timeZone: string,
): ReadonlyArray<DraftOccurrence> =>
  previews.flatMap((preview): ReadonlyArray<DraftOccurrence> => {
    // The focused draft is the live form: a date or time field mid-edit
    // ('' or partial) builds no times. Such a draft is simply not drawn
    // until the field is whole again — never a crash in the grid.
    let times;
    try {
      times = buildEventTimes(preview, timeZone);
    } catch {
      return [];
    }
    const shared = {
      color: preview.color,
      draftId: preview.id,
      endTime: preview.endTime,
      focused: preview.focused,
      isAllDay: preview.isAllDay,
      startTime: preview.startTime,
      title: preview.title,
    };
    if (preview.recurrence === undefined) {
      return times.startUtc < rangeEndUtc && times.endUtc > rangeStartUtc
        ? [
            {
              ...shared,
              ...('endDate' in times ? { endDate: times.endDate, startDate: times.startDate } : {}),
              endUtc: times.endUtc,
              key: preview.id,
              startUtc: times.startUtc,
            },
          ]
        : [];
    }
    return expandRecurringEvent(
      {
        ...('endDate' in times ? { endDate: times.endDate, startDate: times.startDate } : {}),
        endUtc: times.endUtc,
        id: preview.id,
        isAllDay: preview.isAllDay,
        recurrence: preview.recurrence,
        startTimeZone: timeZone,
        startUtc: times.startUtc,
      },
      rangeStartUtc,
      rangeEndUtc,
    ).map((instance) => ({
      ...shared,
      ...(instance.startDate !== undefined
        ? { endDate: instance.endDate, startDate: instance.startDate }
        : {}),
      endUtc: instance.endUtc,
      key: `${preview.id}:${String(instance.startUtc)}`,
      startUtc: instance.startUtc,
    }));
  });

/**
 * Why a draft cannot be written as it stands, in the editor's own words,
 * or undefined: the checks Save runs on the form, for a draft that is
 * not in the form ("Add all").
 */
export const prefillError = (
  prefill: EventEditorPrefill,
  { calendarKey, timeZone }: { calendarKey: string; timeZone: string },
): string | undefined => {
  const invalid = validateEventDraft({ ...prefill, calendarKey }, timeZone);
  if (invalid) {
    return invalid;
  }
  const spec = repeatSpecFrom(seedRepeatFields(prefill.recurrence), prefill.date);
  return spec ? (byDayError(spec) ?? repeatUntilError(spec, prefill.date)) : undefined;
};

/**
 * A draft as the create would write it, for the drafts that are not in
 * the form ("Add all"): the fields a prefill holds and what the form held
 * beyond them while it showed the draft, in the calendar the form has
 * picked (guests only where it can invite), the calendar's default
 * notifications unless they were edited.
 */
export const eventDraftFromPrefill = (
  prefill: EventEditorPrefill,
  {
    accountId,
    calendarId,
    canInvite = false,
    extras,
    timeZone,
  }: {
    accountId: string;
    calendarId: string;
    canInvite?: boolean | undefined;
    extras?: DraftExtras | undefined;
    timeZone: string;
  },
): EventDraft => {
  const recurrence = prefillRecurrence(prefill, timeZone);
  const description = extras?.description.trim();
  const location = prefill.location?.trim();
  // Only coordinates picked for this very text reach the write, as Save does it.
  const geo =
    extras?.geo && location && geoMatches(extras.geo, location)
      ? new GeoLocation({ ...extras.geo, source: location })
      : undefined;
  return {
    accountId,
    ...(canInvite && extras && extras.attendees.length > 0 ? { attendees: extras.attendees } : {}),
    calendarId,
    ...(description ? { description } : {}),
    ...(geo ? { geo } : {}),
    isAllDay: prefill.isAllDay,
    ...(prefill.location ? { location: prefill.location } : {}),
    ...(recurrence ? { recurrence } : {}),
    ...(extras?.reminders ? { reminders: extras.reminders } : {}),
    title: prefill.title.trim(),
    ...buildEventTimes(prefill, timeZone),
  };
};
