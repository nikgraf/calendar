import {
  calendarGroups,
  RSVP_OPTIONS,
  SCOPE_OPTIONS,
  useAccounts,
  type useEventEditorModel,
  type useMoveConfirmation,
  useTimeZones,
} from '@calendar/app-state';
import { type CalendarInfo, draftZoneRange } from '@calendar/core';
import { InviteeCombobox } from './InviteeCombobox.tsx';
import { FIELD_CLASS as field } from './fieldStyles.ts';
import { LocationCombobox } from './LocationCombobox.tsx';
import { LocationMap } from './LocationMap.tsx';
import { MoveConfirm } from './MoveConfirm.tsx';
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
            className="rounded-lg bg-fill p-2 text-sm text-ink-secondary"
            data-testid="event-read-only"
          >
            This calendar is read-only.
          </p>
        ) : null}
        {error ? (
          <p className="select-text rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>
        ) : null}
        {isRecurring ? (
          <div
            aria-label="Apply to"
            className="flex rounded-lg border border-hairline bg-surface p-0.5"
            role="radiogroup"
          >
            {SCOPE_OPTIONS.map((option) => (
              <button
                aria-checked={scope === option.value}
                className={`flex-1 rounded-md px-2 py-1 text-xs font-medium ${
                  scope === option.value
                    ? 'bg-primary text-on-primary'
                    : 'text-ink-secondary hover:bg-fill'
                }`}
                key={option.value}
                onClick={() => setScope(option.value)}
                role="radio"
                type="button"
              >
                {option.label}
              </button>
            ))}
          </div>
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
        <div className="flex gap-2">
          <input
            className={field}
            onChange={(changeEvent) => setDate(changeEvent.target.value)}
            type="date"
            value={date}
          />
          {isAllDay ? null : (
            <>
              <input
                className={field}
                onChange={(changeEvent) => setStartTime(changeEvent.target.value)}
                type="time"
                value={startTime}
              />
              <input
                className={field}
                onChange={(changeEvent) => setEndTime(changeEvent.target.value)}
                type="time"
                value={endTime}
              />
            </>
          )}
        </div>
        {zoneLine ? (
          <p className="-mt-2 text-xs text-ink-secondary" data-testid="event-secondary-times">
            {zoneLine}
          </p>
        ) : null}
        <LocationCombobox model={model} />
        <LocationMap model={model} />
        {existing ? null : <RepeatRuleFields anchorDate={date} state={model} />}
        {canInvite ? (
          <div className="rounded-lg border border-hairline bg-surface p-3">
            <p className="mb-1 text-xs font-medium text-ink-secondary uppercase">Invitees</p>
            {canRsvp ? (
              <div className="mb-2 flex gap-1">
                {RSVP_OPTIONS.map((option) => (
                  <button
                    className={`flex-1 rounded-md border px-2 py-1 text-xs font-medium ${
                      rsvp === option.value
                        ? 'border-primary bg-primary text-on-primary'
                        : 'border-hairline text-ink-secondary hover:bg-fill'
                    }`}
                    key={option.value}
                    onClick={() => void respond(option.value)}
                    type="button"
                  >
                    {option.label}
                  </button>
                ))}
              </div>
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
          <div
            className="rounded-lg border border-hairline bg-surface p-3"
            data-testid="event-guests-read-only"
          >
            <p className="mb-1 text-xs font-medium text-ink-secondary uppercase">Guests</p>
            <ul className="text-sm text-ink-secondary">
              {existing?.attendees?.map((attendee) => (
                <li key={attendee.email}>{attendee.displayName ?? attendee.email}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <RemindersFields model={model} />
      </fieldset>

      <MoveConfirm moveConfirmation={moveConfirmation} />

      <div className="mt-5 flex items-center justify-between">
        {existing && !readOnly ? (
          <button
            aria-busy={busy}
            className={`text-sm text-red-600 hover:underline ${busy ? 'opacity-40' : ''}`}
            onClick={() => void remove()}
            type="button"
          >
            Delete
          </button>
        ) : (
          <span />
        )}
        <div className="flex gap-2">
          <button
            className="rounded-lg px-3 py-1.5 text-sm hover:bg-fill"
            onClick={onClose}
            type="button"
          >
            Cancel
          </button>
          {readOnly ? null : (
            <button
              aria-busy={busy}
              className={`rounded-lg bg-primary px-4 py-1.5 text-sm font-medium text-on-primary hover:bg-primary-hover disabled:opacity-40 ${busy ? 'opacity-40' : ''}`}
              disabled={moveConfirmation.pending !== null}
              onClick={() => void save()}
              type="button"
            >
              Save
            </button>
          )}
        </div>
      </div>
    </>
  );
}
