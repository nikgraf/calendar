import { SegmentedControl } from '../ui/SegmentedControl.tsx';
import {
  calendarGroups,
  RSVP_OPTIONS,
  SCOPE_OPTIONS,
  useAccounts,
  type useEventEditorModel,
  type useMoveConfirmation,
  useTimeZones,
} from '@calendar/app-state';
import { type CalendarInfo, draftZoneRanges, type RsvpResponse } from '@calendar/core';
import { InviteeCombobox } from './InviteeCombobox.tsx';
import { Button } from '../ui/Button.tsx';
import { FIELD_CLASS as field, LABEL_CLASS } from '../ui/fieldStyles.ts';
import { useFieldFlash } from '../ui/useFlash.ts';
import { FindTimeFields } from './FindTimeFields.tsx';
import { LocationCombobox } from './LocationCombobox.tsx';
import { LocationMap } from './LocationMap.tsx';
import { RemindersFields } from './RemindersFields.tsx';
import { RepeatRuleFields } from './RepeatRuleFields.tsx';
import { ZoneLines } from './ZoneLines.tsx';

/**
 * The event half of EventEditor (mode === 'event'), extracted like the iOS
 * EventEditForm. The e2e suite relies on the Title placeholder, the
 * Repeat/Apply-to labels and the Delete/Cancel/Save buttons.
 */
/** Calendars grouped the way the sidebar shows them: per account, Apple per source. */
const groupLabel = (calendar: CalendarInfo, accountLabel: (accountId: string) => string): string =>
  calendar.provider === 'apple'
    ? `Apple Calendar — ${calendar.sourceTitle ?? 'On this Mac'}`
    : accountLabel(calendar.accountId);

export function EventEditorForm({
  model,
  moveConfirmation,
  onClose,
  saveDisabled = false,
}: {
  model: ReturnType<typeof useEventEditorModel>;
  moveConfirmation: ReturnType<typeof useMoveConfirmation>;
  onClose: () => void;
  /** Another write of the editor's is running (the thread's "Add all"): one at a time. */
  saveDisabled?: boolean | undefined;
}) {
  const accounts = useAccounts();
  const { secondary: secondaryZones } = useTimeZones();
  const {
    addAttendee,
    assumedTime,
    attendees,
    attendeeStatus,
    busy,
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
    remove,
    removeAttendee,
    respond,
    rsvp,
    save,
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
  const hasGuests = (existing?.attendees ?? []).length > 0;
  // The draft's times in the other zones; null for all-day or before the times build.
  const zoneLines = draftZoneRanges(
    { date, endDate, endTime, isAllDay, startTime },
    model.timeZone,
    secondaryZones,
  );

  return (
    <>
      <fieldset className="flex min-w-0 flex-col gap-3" disabled={readOnly}>
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
        <input
          autoFocus
          className={field}
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
          <p className="-mt-1 text-xs text-ink-secondary" data-testid="assumed-time">
            Time assumed from the phrase — set it, or say one.
          </p>
        ) : null}
        {zoneLines ? <ZoneLines className="-mt-2" lines={zoneLines} /> : null}
        {readOnly ? null : <FindTimeFields model={model} />}
        <LocationCombobox model={model} />
        <LocationMap place={model} />
        {model.repeatLoaded ? <RepeatRuleFields anchorDate={date} state={model} /> : null}
        {canInvite ? (
          <div className="rounded-control bg-fill p-3">
            <p className="mb-1 text-xs font-medium text-ink-secondary uppercase">Invitees</p>
            {canRsvp ? (
              <SegmentedControl
                className="mb-2 w-full"
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
          </div>
        ) : readOnly && !hasGuests ? null : (
          // EventKit cannot write guests: existing ones show as they are, and
          // the field stays in sight, disabled, pointing at Calendar.app — a
          // missing field reads as a bug.
          <div className="rounded-control bg-fill p-3" data-testid="event-invitees-apple">
            <p className="mb-1 text-xs font-medium text-ink-secondary uppercase">Invitees</p>
            {hasGuests ? (
              <ul className="mb-2 text-sm text-ink-secondary" data-testid="event-guests-read-only">
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
                <p className="mt-2 text-xs text-ink-secondary">
                  {existing
                    ? 'Apple calendars can’t add invitees here — add them in Calendar.'
                    : 'Apple calendars can’t add invitees here — save, then add them in Calendar.'}{' '}
                  <button
                    className="text-primary hover:underline"
                    onClick={() => void window.calendarBridge.appleCalendarOpen()}
                    type="button"
                  >
                    Open Calendar
                  </button>
                </p>
              </>
            )}
          </div>
        )}
        <RemindersFields model={model} />
        <label className={LABEL_CLASS}>
          Notes
          <textarea
            className={`${field} mt-1 min-h-16`}
            data-testid="editor-notes"
            onChange={(changeEvent) => setDescription(changeEvent.target.value)}
            placeholder="Add notes"
            value={description}
          />
        </label>
      </fieldset>

      <div className="mt-5 flex items-center justify-between">
        {existing && !readOnly ? (
          <Button aria-busy={busy} onClick={() => void remove()} size="sm" variant="danger">
            Delete
          </Button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <Button onClick={onClose} size="sm" variant="ghost">
            Cancel
          </Button>
          {readOnly ? null : (
            <Button
              aria-busy={busy}
              disabled={moveConfirmation.pending !== null || saveDisabled}
              onClick={() => void save()}
              size="sm"
              variant="primary"
            >
              Save
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
