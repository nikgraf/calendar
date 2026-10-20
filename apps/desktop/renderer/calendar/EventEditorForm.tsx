import { SegmentedControl } from '../ui/SegmentedControl.tsx';
import {
  calendarGroups,
  RSVP_OPTIONS,
  SCOPE_OPTIONS,
  useAccounts,
  type useEventEditorModel,
  useTimeZones,
} from '@calendar/app-state';
import { type CalendarInfo, draftZoneRanges, type RsvpResponse } from '@calendar/core';
import { InviteeCombobox } from './InviteeCombobox.tsx';
import { FIELD_CLASS as field } from '../ui/fieldStyles.ts';
import { useFieldFlash } from '../ui/useFlash.ts';
import { FindTimeFields } from './FindTimeFields.tsx';
import { FormSection } from './FormSection.tsx';
import { LocationCombobox } from './LocationCombobox.tsx';
import { LocationMap } from './LocationMap.tsx';
import { RemindersFields } from './RemindersFields.tsx';
import { RepeatRuleFields } from './RepeatRuleFields.tsx';
import { ZoneLines } from './ZoneLines.tsx';
import { TEXT_LINK_CLASS } from '../ui/buttonStyles.ts';

/** Calendars grouped the way the sidebar shows them: per account, Apple per source. */
const groupLabel = (calendar: CalendarInfo, accountLabel: (accountId: string) => string): string =>
  calendar.provider === 'apple'
    ? `Apple Calendar — ${calendar.sourceTitle ?? 'On this Mac'}`
    : accountLabel(calendar.accountId);

/**
 * The event half of EditorPanel (mode === 'event'), extracted like the
 * iOS EventEditForm: the title and its calendar, then When (all-day, the
 * dates, the finder), Where, the repeat rule, Invitees, Notifications and
 * Notes as captioned sections. The panel's footer carries Delete, Cancel
 * and Save. The e2e suite relies on the Title placeholder, the field
 * aria-labels and the Repeat/Apply-to labels.
 */
export function EventEditorForm({ model }: { model: ReturnType<typeof useEventEditorModel> }) {
  const accounts = useAccounts();
  const { secondary: secondaryZones } = useTimeZones();
  const {
    addAttendee,
    assumedTime,
    attendees,
    attendeeStatus,
    calendarKey,
    canInvite,
    canMoveCalendar,
    canRsvp,
    canSwitchAllDay,
    date,
    description,
    endDate,
    endTime,
    error,
    existing,
    isAllDay,
    isRecurring,
    readOnly,
    removeAttendee,
    respond,
    rsvp,
    scope,
    setCalendarKey,
    setDate,
    setDescription,
    setEndDate,
    setEndTime,
    setIsAllDay,
    setScope,
    setStartTime,
    setTitle,
    startTime,
    title,
    writableCalendars: writable,
  } = model;
  const accountLabel = (accountId: string) =>
    accounts.find((account) => account.id === accountId)?.email ?? accountId;
  // What the last turn changed tints and fades back (the thread's flash).
  const titleFlash = useFieldFlash<HTMLInputElement>('title');
  const allDayFlash = useFieldFlash<HTMLLabelElement>(isAllDay ? 'time' : null);
  const dateFlash = useFieldFlash<HTMLInputElement>('date');
  const endDateFlash = useFieldFlash<HTMLInputElement>('date');
  const startFlash = useFieldFlash<HTMLInputElement>('time');
  const endFlash = useFieldFlash<HTMLInputElement>('time');
  const guestsFlash = useFieldFlash<HTMLDivElement>('guests');
  const hasGuests = (existing?.attendees ?? []).length > 0;
  // The draft's times in the other zones; null for all-day or before the times build.
  const zoneLines = draftZoneRanges(
    { date, endDate, endTime, isAllDay, startTime },
    model.timeZone,
    secondaryZones,
  );

  return (
    <fieldset className="flex min-w-0 flex-col gap-5" disabled={readOnly}>
      {readOnly ? (
        <p
          className="rounded-control bg-fill p-2 text-sm text-ink-secondary"
          data-testid="event-read-only"
        >
          This calendar is read-only.
        </p>
      ) : null}
      {error ? (
        <p className="select-text rounded-control bg-fill p-2 text-sm text-danger">{error}</p>
      ) : null}
      {isRecurring ? (
        <SegmentedControl
          className="w-full"
          grow
          label="Apply to"
          onChange={setScope}
          options={SCOPE_OPTIONS.map((option) => ({ label: option.label, value: option.value }))}
          size="sm"
          value={scope}
        />
      ) : null}
      <div className="flex flex-col gap-2">
        <input
          autoFocus
          className={`${field} py-2 text-base`}
          onChange={(changeEvent) => setTitle(changeEvent.target.value)}
          placeholder="Title"
          ref={titleFlash}
          value={title}
        />
        {readOnly ? null : (
          <select
            aria-label="Calendar"
            className={field}
            disabled={Boolean(existing) && !canMoveCalendar}
            onChange={(changeEvent) => setCalendarKey(changeEvent.target.value)}
            title={
              existing && !canMoveCalendar ? 'Choose "All events" to move a series' : undefined
            }
            value={calendarKey}
          >
            {calendarGroups(writable, (calendar) => groupLabel(calendar, accountLabel)).map(
              (group) => (
                <optgroup key={group.label} label={group.label}>
                  {group.calendars.map((calendar) => (
                    <option
                      key={`${calendar.accountId}:${calendar.id}`}
                      value={`${calendar.accountId}:${calendar.id}`}
                    >
                      {calendar.summary}
                    </option>
                  ))}
                </optgroup>
              ),
            )}
          </select>
        )}
      </div>

      <FormSection label="When">
        <label
          className="-mx-1 flex items-center gap-2 rounded-control px-1 text-sm"
          ref={allDayFlash}
          title={canSwitchAllDay ? undefined : 'A repeating event stays timed or all-day'}
        >
          <input
            checked={isAllDay}
            disabled={!canSwitchAllDay}
            onChange={(changeEvent) => setIsAllDay(changeEvent.target.checked)}
            type="checkbox"
          />
          All-day
        </label>
        {/* Start and end each get a line, a date and a time: a multi-day or overnight
            event ends on a later day, and all three fields on one line ran past the panel's edge. */}
        <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-2">
          <span className="text-sm text-ink-secondary">Starts</span>
          <input
            aria-label="Date"
            className={`${field} min-w-0 ${isAllDay ? 'col-span-2' : ''}`}
            onChange={(changeEvent) => setDate(changeEvent.target.value)}
            ref={dateFlash}
            type="date"
            value={date}
          />
          {isAllDay ? null : (
            <input
              aria-label="Start time"
              className={`${field} min-w-0`}
              onChange={(changeEvent) => setStartTime(changeEvent.target.value)}
              ref={startFlash}
              type="time"
              value={startTime}
            />
          )}
          <span className="text-sm text-ink-secondary">Ends</span>
          <input
            aria-label="End date"
            className={`${field} min-w-0 ${isAllDay ? 'col-span-2' : ''}`}
            onChange={(changeEvent) => setEndDate(changeEvent.target.value)}
            ref={endDateFlash}
            type="date"
            value={endDate}
          />
          {isAllDay ? null : (
            <input
              aria-label="End time"
              className={`${field} min-w-0`}
              onChange={(changeEvent) => setEndTime(changeEvent.target.value)}
              ref={endFlash}
              type="time"
              value={endTime}
            />
          )}
        </div>
        {assumedTime && !isAllDay ? (
          <p className="text-xs text-ink-secondary" data-testid="assumed-time">
            Time assumed from the phrase — set it, or say one.
          </p>
        ) : null}
        {zoneLines ? <ZoneLines lines={zoneLines} /> : null}
        {readOnly ? null : <FindTimeFields model={model} />}
      </FormSection>

      <FormSection label="Where">
        <LocationCombobox model={model} />
        <LocationMap place={model} />
      </FormSection>

      {model.repeatLoaded ? <RepeatRuleFields anchorDate={date} state={model} /> : null}

      {canInvite ? (
        <FormSection label="Invitees" ref={guestsFlash}>
          {canRsvp ? (
            <SegmentedControl
              className="w-full"
              grow
              label="RSVP"
              onChange={(value) => {
                if (value !== 'needsAction') {
                  void respond(value);
                }
              }}
              options={RSVP_OPTIONS.map((option) => ({
                label: option.label,
                value: option.value as RsvpResponse | 'needsAction',
              }))}
              size="sm"
              value={rsvp ?? 'needsAction'}
            />
          ) : null}
          <InviteeCombobox
            attendees={attendees}
            attendeeStatus={attendeeStatus}
            onAdd={addAttendee}
            onRemove={removeAttendee}
          />
        </FormSection>
      ) : readOnly && !hasGuests ? null : (
        // EventKit cannot write guests: existing ones show as they are, and
        // the field stays in sight, disabled, pointing at Calendar.app — a
        // missing field reads as a bug.
        <FormSection label="Invitees" testId="event-invitees-apple">
          {hasGuests ? (
            <ul className="text-sm text-ink-secondary" data-testid="event-guests-read-only">
              {existing?.attendees?.map((attendee) => (
                <li key={attendee.email}>{attendee.displayName ?? attendee.email}</li>
              ))}
            </ul>
          ) : null}
          {readOnly ? null : (
            <>
              <input
                aria-label="Invitees"
                className="w-full rounded-lg border border-hairline bg-surface px-3 py-1 text-sm outline-none placeholder:text-ink-secondary disabled:opacity-50"
                disabled
                placeholder="Add guests"
              />
              {!existing && attendees.length > 0 ? (
                // Guests the form holds (typed, or said in a phrase) for
                // another calendar: kept, but not sent from this one.
                <p className="text-xs text-ink-secondary" data-testid="event-invitees-held">
                  Not invited from this calendar:{' '}
                  {attendees.map((attendee) => attendee.displayName ?? attendee.email).join(', ')}
                </p>
              ) : null}
              <p className="text-xs text-ink-secondary">
                {existing
                  ? 'Apple calendars can’t add invitees here — add them in Calendar.'
                  : 'Apple calendars can’t add invitees here — save, then add them in Calendar.'}{' '}
                <button
                  className={TEXT_LINK_CLASS}
                  onClick={() => void window.calendarBridge.appleCalendarOpen()}
                  type="button"
                >
                  Open Calendar
                </button>
              </p>
            </>
          )}
        </FormSection>
      )}

      <RemindersFields model={model} />

      <FormSection label="Notes">
        <textarea
          className={`${field} min-h-16`}
          data-testid="editor-notes"
          onChange={(changeEvent) => setDescription(changeEvent.target.value)}
          placeholder="Add notes"
          value={description}
        />
      </FormSection>
    </fieldset>
  );
}
