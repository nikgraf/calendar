import {
  useFindTimeModel,
  useModelAvailability,
  type useEventEditorModel,
} from '@calendar/app-state';
import {
  FINDER_BOUNDS,
  FINDER_DAYS,
  FINDER_DURATIONS,
  FINDER_WINDOWS,
  formatSlotLabel,
  minutesBetween,
} from '@calendar/core';
import { desktopLanguageModel } from '../ai/desktopModel.ts';
import { backend } from '../backend.ts';
import { Button } from '../ui/Button.tsx';
import { FIELD_CLASS, LABEL_CLASS } from '../ui/fieldStyles.ts';
import { SegmentedControl } from '../ui/SegmentedControl.tsx';

/**
 * "Find a time" beside the event's date and times: a few presets over
 * the pure solver (window, hours, days, duration), a Search, and the
 * free slots as buttons — a pick moves the event there. With the
 * on-device model a phrase fills the presets; without it the finder
 * works the same. The duration starts as the form's own.
 */
export function FindTimeFields({ model }: { model: ReturnType<typeof useEventEditorModel> }) {
  const { status } = useModelAvailability(desktopLanguageModel);
  const { existing, scope } = model;
  const finder = useFindTimeModel({
    backend,
    durationMinutes: model.isAllDay ? 60 : minutesBetween(model.startTime, model.endTime),
    // The event being moved is not in its own way: its row, and for a
    // series edit beyond this occurrence, its other occurrences too.
    excludeEvent: existing
      ? (event) =>
          event.calendarId === existing.calendarId &&
          (event.id === existing.id ||
            (scope !== 'instance' &&
              existing.recurringEventId !== undefined &&
              event.recurringEventId === existing.recurringEventId))
      : undefined,
    model: desktopLanguageModel,
    onTitle: (title) => {
      if (model.title.trim() === '') {
        model.setTitle(title);
      }
    },
    timeZone: model.timeZone,
  });

  // An all-day series keeps its kind: no slot could be applied.
  if (model.isAllDay && !model.canSwitchAllDay) {
    return null;
  }
  if (!finder.open) {
    return (
      <div>
        <Button data-testid="find-time" onClick={finder.openFinder} size="sm">
          Find a time
        </Button>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2 rounded-control bg-fill p-3" data-testid="find-time-fields">
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold text-primary">Find a time</span>
        <Button data-testid="find-time-close" onClick={finder.close} size="sm" variant="ghost">
          Close
        </Button>
      </div>
      {status === 'ready' ? (
        <div className="flex items-center gap-2">
          <input
            aria-label="Describe the time you need"
            className={FIELD_CLASS}
            data-testid="find-time-phrase"
            disabled={finder.busy}
            onChange={(input) => finder.setPhrase(input.target.value)}
            onKeyDown={(key) => {
              if (key.key === 'Enter') {
                key.preventDefault();
                void finder.readPhrase();
              }
            }}
            placeholder="90 min focus next week, mornings"
            value={finder.phrase}
          />
          <Button
            disabled={finder.busy || finder.phrase.trim() === ''}
            onClick={() => void finder.readPhrase()}
            size="sm"
          >
            Read
          </Button>
        </div>
      ) : null}
      <SegmentedControl
        className="w-full"
        grow
        label="When"
        onChange={finder.setWindow}
        options={FINDER_WINDOWS.map((option) => ({
          label: option.label,
          testId: `find-time-window-${option.value}`,
          value: option.value,
        }))}
        size="sm"
        value={finder.window}
      />
      <SegmentedControl
        className="w-full"
        grow
        label="Hours"
        onChange={finder.setBounds}
        options={FINDER_BOUNDS.map((option) => ({
          label: option.label,
          testId: `find-time-bounds-${option.value}`,
          value: option.value,
        }))}
        size="sm"
        value={finder.bounds}
      />
      <SegmentedControl
        className="w-full"
        grow
        label="Days"
        onChange={finder.setDays}
        options={FINDER_DAYS.map((option) => ({
          label: option.label,
          testId: `find-time-days-${option.value}`,
          value: option.value,
        }))}
        size="sm"
        value={finder.days}
      />
      {finder.customNote ? (
        <p className="text-xs text-ink-secondary" data-testid="find-time-custom">
          From the phrase: {finder.customNote}
        </p>
      ) : null}
      <div>
        <span className={LABEL_CLASS}>Duration</span>
        <div className="mt-1 flex flex-wrap gap-1.5">
          {FINDER_DURATIONS.map((option) => (
            <Button
              aria-pressed={finder.constraints.durationMinutes === option.minutes}
              className={
                finder.constraints.durationMinutes === option.minutes ? 'ring-2 ring-focus' : ''
              }
              data-testid={`find-time-duration-${option.minutes}`}
              key={option.minutes}
              onClick={() => finder.setDuration(option.minutes)}
              size="sm"
            >
              {option.label}
            </Button>
          ))}
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-ink-secondary">
          {finder.error ?? (finder.busy ? 'Looking for a slot…' : '')}
        </span>
        <Button
          data-testid="find-time-search"
          disabled={finder.busy}
          onClick={() => void finder.search()}
          size="sm"
          variant="primary"
        >
          Search
        </Button>
      </div>
      {finder.slots && finder.slots.length > 0 ? (
        <div className="flex flex-wrap gap-1.5" data-testid="find-time-slots">
          {finder.slots.map((slot, index) => (
            <Button
              data-testid={`find-time-slot-${index}`}
              key={`${slot.date}T${slot.startTime}`}
              onClick={() => {
                model.applySlot(slot);
                finder.close();
              }}
              size="sm"
            >
              {formatSlotLabel(slot)}
            </Button>
          ))}
        </div>
      ) : null}
    </div>
  );
}
