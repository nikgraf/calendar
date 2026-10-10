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
import { type CalendarInfo, draftZoneRange, type RsvpResponse } from '@calendar/core';
import { InviteeCombobox } from './InviteeCombobox.tsx';
import { Button } from '../ui/Button.tsx';
import { FIELD_CLASS as field, LABEL_CLASS } from '../ui/fieldStyles.ts';
import { FindTimeFields } from './FindTimeFields.tsx';
import { LocationCombobox } from './LocationCombobox.tsx';
import { LocationMap } from './LocationMap.tsx';
import { RemindersFields } from './RemindersFields.tsx';
import { RepeatRuleFields } from './RepeatRuleFields.tsx';

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
}: {
  model: ReturnType<typeof useEventEditorModel>;
  moveConfirmation: ReturnType<typeof useMoveConfirmation>;
  onClose: () => void;
}) {
  const accounts = useAccounts();
  const { secondary: secondaryZones } = useTimeZones();
  const {
    addAttendee,
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
  const readOnlyGuests = !canInvite && (existing?.attendees ?? []).length > 0;
  // The draft's times in the other zones; null for all-day or before the times build.
  const zoneLine = draftZoneRange(
    { date, endTime, isAllDay, startTime },
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
          className="flex items-center gap-2 text-sm"
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
        {/* The date gets its own line: beside both times it ran the end time past the panel's edge. */}
        <div className="flex flex-col gap-2">
          <input
            aria-label="Date"
            className={field}
            onChange={(changeEvent) => setDate(changeEvent.target.value)}
            type="date"
            value={date}
          />
          {isAllDay ? null : (
            <div className="flex items-center gap-2">
              <input
                aria-label="Start time"
                className={`${field} min-w-0`}
                onChange={(changeEvent) => setStartTime(changeEvent.target.value)}
                type="time"
                value={startTime}
              />
              <span aria-hidden className="text-sm text-ink-secondary">
                –
              </span>
              <input
                aria-label="End time"
                className={`${field} min-w-0`}
                onChange={(changeEvent) => setEndTime(changeEvent.target.value)}
                type="time"
                value={endTime}
              />
            </div>
          )}
        </div>
        {zoneLine ? (
          <p className="-mt-2 text-xs text-ink-secondary" data-testid="event-secondary-times">
            {zoneLine}
          </p>
        ) : null}
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
        ) : readOnlyGuests ? (
          // EventKit cannot write guests: shown as they are, never edited.
          <div className="rounded-control bg-fill p-3" data-testid="event-guests-read-only">
            <p className="mb-1 text-xs font-medium text-ink-secondary uppercase">Guests</p>
            <ul className="text-sm text-ink-secondary">
              {existing?.attendees?.map((attendee) => (
                <li key={attendee.email}>{attendee.displayName ?? attendee.email}</li>
              ))}
            </ul>
          </div>
        ) : null}
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
              disabled={moveConfirmation.pending !== null}
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
