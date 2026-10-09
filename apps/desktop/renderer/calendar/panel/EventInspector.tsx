import {
  RSVP_OPTIONS,
  SCOPE_OPTIONS,
  useEventEditorModel,
  useMoveConfirmation,
  useTimeZones,
} from '@calendar/app-state';
import {
  type CalendarInfo,
  draftZoneRange,
  type EventRecord,
  formatPlainTime,
  type RsvpResponse,
  Temporal,
  utcMsToPlainDate,
} from '@calendar/core';
import { Button } from '../../ui/Button.tsx';
import { IconButton } from '../../ui/IconButton.tsx';
import {
  ChevronLeftIcon,
  MapPinIcon,
  RepeatIcon,
  UsersIcon,
  VideoIcon,
  XIcon,
} from '../../ui/icons.tsx';
import { SegmentedControl } from '../../ui/SegmentedControl.tsx';
import { LocationMap } from '../LocationMap.tsx';
import { MoveConfirm } from '../MoveConfirm.tsx';

const STATUS_LABEL: Record<string, string> = {
  accepted: 'accepted',
  declined: 'declined',
  needsAction: 'no reply',
  tentative: 'maybe',
};

/**
 * The read-first view of an event, in the side panel: a click on the
 * grid or a search result opens it, Edit opens the editor. It answers the
 * quick questions without a form — when, where, who, the meeting link,
 * the notes — and carries the two actions that need no form: RSVP and
 * Delete (with the series scope, when the event repeats).
 */
export function EventInspector({
  calendars,
  event,
  onBack,
  onClose,
  onConvert,
  onEdit,
  timeZone,
}: {
  calendars: ReadonlyArray<CalendarInfo>;
  event: EventRecord;
  /** Opened from search: "Results" goes back there, and so does a delete. */
  onBack?: (() => void) | undefined;
  onClose: () => void;
  /** Convert to a task: opens the editor in task mode. */
  onConvert: () => void;
  onEdit: () => void;
  timeZone: string;
}) {
  const moveConfirmation = useMoveConfirmation();
  const model = useEventEditorModel({
    calendars,
    confirm: moveConfirmation.request,
    onClose: onBack ?? onClose,
    seed: { event, initialDate: Temporal.PlainDate.from(utcMsToPlainDate(event.startUtc)) },
    timeZone,
  });
  const { secondary: secondaryZones } = useTimeZones();
  const {
    attendees,
    attendeeStatus,
    busy,
    canRsvp,
    date,
    description,
    endTime,
    error,
    isAllDay,
    isRecurring,
    joinUrl,
    location,
    readOnly,
    remove,
    respond,
    rsvp,
    scope,
    setScope,
    startTime,
    title,
  } = model;
  const calendar = calendars.find(
    (candidate) => candidate.accountId === event.accountId && candidate.id === event.calendarId,
  );
  const day = Temporal.PlainDate.from(date).toLocaleString('en-US', {
    day: 'numeric',
    month: 'long',
    weekday: 'long',
  });
  const zoneLine = draftZoneRange({ date, endTime, isAllDay, startTime }, timeZone, secondaryZones);

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="inspector">
      {onBack ? (
        <div className="px-2 pt-2">
          <Button data-testid="inspector-back" onClick={onBack} size="sm" variant="ghost">
            <ChevronLeftIcon size={14} />
            Results
          </Button>
        </div>
      ) : null}
      <div className="flex items-center gap-2 px-4 pt-3">
        <span
          aria-hidden
          className="size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: calendar?.colorHex ?? 'var(--border-strong)' }}
        />
        <span className="min-w-0 flex-1 truncate text-xs text-ink-secondary">
          {calendar?.summary ?? 'Calendar'}
        </span>
        <IconButton data-testid="inspector-close" label="Close" onClick={onClose} size="sm">
          <XIcon size={14} />
        </IconButton>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-4 pt-2 pb-4">
        <h2 className="text-lg leading-tight font-semibold" data-testid="inspector-title">
          {title}
        </h2>
        <div className="text-sm">
          <p>{day}</p>
          <p className="text-ink-secondary">
            {isAllDay ? 'All day' : `${formatPlainTime(startTime)} – ${formatPlainTime(endTime)}`}
          </p>
          {zoneLine ? (
            <p className="text-xs text-ink-secondary" data-testid="event-secondary-times">
              {zoneLine}
            </p>
          ) : null}
        </div>
        {readOnly ? (
          <p
            className="rounded-control bg-fill p-2 text-sm text-ink-secondary"
            data-testid="event-read-only"
          >
            This calendar is read-only.
          </p>
        ) : null}
        {error ? (
          <p className="rounded-control bg-fill p-2 text-sm text-danger select-text">{error}</p>
        ) : null}
        {joinUrl ? (
          <Button
            className="w-full"
            onClick={() => window.open(joinUrl, '_blank', 'noopener')}
            variant="primary"
          >
            <VideoIcon size={14} />
            Join meeting
          </Button>
        ) : null}
        {isRecurring ? (
          <div className="flex flex-col gap-1.5">
            <p className="flex items-center gap-1.5 text-sm text-ink-secondary">
              <RepeatIcon size={14} />
              Repeating event
            </p>
            {readOnly ? null : (
              <SegmentedControl
                className="w-full"
                grow
                label="Apply to"
                onChange={setScope}
                options={SCOPE_OPTIONS.map((option) => ({
                  label: option.label,
                  value: option.value,
                }))}
                size="sm"
                value={scope}
              />
            )}
          </div>
        ) : null}
        {location ? (
          <div className="flex flex-col gap-2">
            <p className="flex items-start gap-1.5 text-sm">
              <MapPinIcon className="mt-0.5 shrink-0 text-ink-secondary" size={14} />
              <span className="min-w-0 break-words select-text">{location}</span>
            </p>
            <LocationMap model={model} />
          </div>
        ) : null}
        {attendees.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <p className="flex items-center gap-1.5 text-xs font-medium text-ink-secondary uppercase">
              <UsersIcon size={14} />
              Invitees
            </p>
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
            <ul className="text-sm">
              {attendees.map((attendee) => {
                const status = attendeeStatus(attendee.email);
                return (
                  <li className="flex items-center justify-between gap-2" key={attendee.email}>
                    <span className="min-w-0 truncate select-text">
                      {attendee.displayName ?? attendee.email}
                    </span>
                    <span className="shrink-0 text-xs text-ink-secondary">
                      {STATUS_LABEL[status?.responseStatus ?? 'needsAction']}
                    </span>
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
        {description ? (
          <p className="text-sm whitespace-pre-wrap select-text" data-testid="inspector-notes">
            {description}
          </p>
        ) : null}
        <MoveConfirm moveConfirmation={moveConfirmation} />
      </div>
      <div className="flex items-center gap-2 border-t border-hairline px-4 py-3">
        {readOnly ? null : (
          <Button aria-busy={busy} onClick={() => void remove()} size="sm" variant="danger">
            Delete
          </Button>
        )}
        <div className="flex-1" />
        {readOnly ? null : (
          <Button
            data-testid="inspector-convert"
            disabled={isRecurring && scope !== 'series'}
            onClick={onConvert}
            size="sm"
            title={
              isRecurring && scope !== 'series'
                ? 'Choose "All events" to convert a series'
                : undefined
            }
            variant="ghost"
          >
            Convert to task
          </Button>
        )}
        <Button data-testid="inspector-edit" onClick={onEdit} size="sm" variant="primary">
          Edit
        </Button>
      </div>
    </div>
  );
}
