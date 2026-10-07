import { makeFindSlots, type CaptureSource } from '@calendar/ai';
import {
  eventDraftFromPrefill,
  getLastUsedCalendarKey,
  rememberCalendar,
  taskParamsFromPrefill,
  useCalendars,
  useGuardedMutations,
  useModelAvailability,
  useQuickAddModel,
  useTaskLists,
  type EventEditorPrefill,
  type QuickAddReview,
  type TaskEditorSeed,
} from '@calendar/app-state';
import { formatSlotLabel, isCalendarWritable, type Temporal } from '@calendar/core';
import { type RefObject, useRef, useState } from 'react';
import { desktopLanguageModel } from '../ai/desktopModel.ts';
import { desktopSpeech } from '../ai/desktopSpeech.ts';
import { backend } from '../backend.ts';
import { Button } from '../ui/Button.tsx';
import { IconButton } from '../ui/IconButton.tsx';
import { CalendarIcon, CheckCircleIcon, MicIcon, SparkleIcon } from '../ui/icons.tsx';
import { Popover } from '../ui/Popover.tsx';
import { SegmentedControl } from '../ui/SegmentedControl.tsx';
import { captureSourceOf, isCapturableInPhrase, readPaste } from './captureClipboard.ts';

/** The field's placeholder; the e2e specs find the field by it. */
export const QUICK_ADD_PLACEHOLDER = 'Lunch with Sarah tomorrow at 1';
const FIND_PLACEHOLDER = '90 min focus this week, mornings';

/** Re-check the model when the window regains focus (Apple Intelligence is switched on in System Settings). */
const onWindowFocus = (onActive: () => void): (() => void) => {
  window.addEventListener('focus', onActive);
  return () => window.removeEventListener('focus', onActive);
};

const reviewLine = (review: QuickAddReview): string => {
  const day = new Date(`${review.prefill.date}T12:00:00`).toLocaleDateString('en-US', {
    day: 'numeric',
    month: 'short',
    weekday: 'short',
  });
  if (review.kind === 'task') {
    return review.prefill.time ? `${day} · ${review.prefill.time}` : day;
  }
  return review.prefill.isAllDay
    ? `${day} · all day`
    : `${day} · ${review.prefill.startTime} – ${review.prefill.endTime}`;
};

/**
 * The toolbar's quick-add field: natural-language add and find-a-time on
 * the bundled Foundation Models helper, always in view (⌘K focuses it).
 * A parse is held for a look — the "Understood as" card under the field
 * with an Event/Task toggle — and either opens the editor or is added as
 * it stands. The desktop sibling of the iOS quick-add sheet: same model,
 * same hand-off.
 */
export function QuickAddField({
  focusedDate,
  inputRef,
  onCapture,
  onParsed,
  onTaskParsed,
  timeZone,
}: {
  /** Undated phrases land on the day being viewed. */
  focusedDate: Temporal.PlainDate;
  /** ⌘K focuses the field through this. */
  inputRef: RefObject<HTMLInputElement | null>;
  /** A pasted email or image is not a phrase: it goes to capture. */
  onCapture: (source: CaptureSource) => void;
  onParsed: (prefill: EventEditorPrefill) => void;
  onTaskParsed: (seed: TaskEditorSeed) => void;
  timeZone: string;
}) {
  const { checking, retry, status } = useModelAvailability(desktopLanguageModel, onWindowFocus);
  const findSlotsRef = useRef(makeFindSlots(desktopLanguageModel, backend, timeZone));
  const calendars = useCalendars();
  const taskLists = useTaskLists();
  const { createEvent, createTask } = useGuardedMutations();
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null);
  const model = useQuickAddModel({
    fallbackDate: focusedDate.toString(),
    findSlots: (phrase) => findSlotsRef.current(phrase),
    model: desktopLanguageModel,
    onPrefill: onParsed,
    onTaskPrefill: (prefill) =>
      onTaskParsed({
        dated: true,
        initialDate: prefill.date,
        initialTime: prefill.time,
        title: prefill.title,
      }),
    reviewFirst: true,
    speech: desktopSpeech,
    timeZone,
  });
  const {
    busy,
    confirmReview,
    dismissReview,
    error,
    found,
    mode,
    phrase,
    pickSlot,
    review,
    setMode,
    setPhrase,
    setReviewKind,
    startRecording,
    stopRecording,
    submit,
    voice,
    voiceAvailable,
  } = model;
  const unavailable = status !== null && status !== 'ready';

  const openCard = () => {
    const rect = inputRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchor({ x: rect.left - 40, y: rect.bottom + 6 });
    }
  };
  const close = () => {
    setAnchor(null);
    dismissReview();
  };

  const writableCalendar = () => {
    const writable = calendars.filter(isCalendarWritable);
    const last = getLastUsedCalendarKey();
    return (
      writable.find((calendar) => `${calendar.accountId}:${calendar.id}` === last) ?? writable[0]
    );
  };
  const calendarName = writableCalendar()?.summary ?? 'No calendar';

  /** "Add event" / "Add task": the item as understood, written without the editor. */
  const addNow = () => {
    if (!review) {
      return;
    }
    if (review.kind === 'event') {
      const calendar = writableCalendar();
      if (!calendar) {
        return;
      }
      rememberCalendar(`${calendar.accountId}:${calendar.id}`);
      void createEvent(
        eventDraftFromPrefill(
          review.prefill,
          { accountId: calendar.accountId, calendarId: calendar.id },
          timeZone,
        ),
      );
    } else {
      const list = taskLists.find((candidate) => candidate.isVisible && !candidate.readOnly);
      if (!list) {
        return;
      }
      void createTask(taskParamsFromPrefill(review.prefill, list));
    }
    setPhrase('');
    close();
  };

  const showCard = anchor !== null && (review !== null || found !== null);

  return (
    <>
      <label
        className={`flex h-8 w-[340px] items-center gap-2 rounded-control bg-fill pr-1 pl-2.5 text-sm text-ink-secondary focus-within:ring-2 focus-within:ring-focus ${
          unavailable ? 'opacity-70' : ''
        }`}
        style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        title={
          unavailable
            ? "The on-device model is unavailable — Solunivo's AI features need macOS 26 with Apple Intelligence enabled."
            : undefined
        }
      >
        <SparkleIcon className="shrink-0 text-primary" />
        <input
          aria-label={mode === 'find' ? 'Find a time' : 'Quick add'}
          className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-secondary disabled:cursor-default"
          data-testid="quick-add-input"
          disabled={busy || unavailable}
          onChange={(input) => setPhrase(input.target.value)}
          onKeyDown={(key) => {
            if (key.key === 'Enter') {
              openCard();
              void submit();
            } else if (key.key === 'Escape') {
              close();
              key.currentTarget.blur();
            }
          }}
          onPaste={(event) => {
            const pasted = readPaste(event.clipboardData);
            if (mode !== 'add' || !isCapturableInPhrase(pasted)) {
              return;
            }
            event.preventDefault();
            event.currentTarget.blur();
            void captureSourceOf(pasted).then((source) => {
              if (source) {
                onCapture(source);
              }
            });
          }}
          placeholder={
            unavailable
              ? 'Model unavailable'
              : mode === 'find'
                ? FIND_PLACEHOLDER
                : QUICK_ADD_PLACEHOLDER
          }
          ref={inputRef}
          value={phrase}
        />
        {unavailable ? (
          <Button disabled={checking} onClick={retry} size="sm" variant="ghost">
            Retry
          </Button>
        ) : null}
        {voiceAvailable && !busy && !unavailable && voice !== 'transcribing' ? (
          <IconButton
            active={voice === 'recording'}
            className={voice === 'recording' ? 'text-danger' : ''}
            disabled={voice === 'preparing'}
            label={voice === 'recording' ? 'Stop dictating' : 'Dictate'}
            onClick={() => {
              openCard();
              void (voice === 'recording' ? stopRecording() : startRecording());
            }}
            size="sm"
          >
            <MicIcon />
          </IconButton>
        ) : null}
        <SegmentedControl
          label="Quick-add mode"
          onChange={(next) => {
            close();
            setMode(next);
          }}
          options={[
            { label: 'Add', value: 'add' },
            { label: 'Find time', value: 'find' },
          ]}
          size="sm"
          value={mode}
        />
      </label>
      {!showCard && (voice !== 'idle' || error || busy) ? (
        <p
          className={`absolute top-13 left-1/2 z-30 -translate-x-1/2 rounded-control bg-surface-raised px-3 py-1.5 text-xs shadow-md ${
            error ? 'text-danger' : 'text-ink-secondary'
          }`}
          role="status"
        >
          {voice === 'preparing'
            ? 'Preparing dictation…'
            : voice === 'recording'
              ? 'Listening — click the microphone when finished.'
              : voice === 'transcribing'
                ? 'Transcribing…'
                : busy
                  ? mode === 'find'
                    ? 'Looking for a slot…'
                    : 'Reading…'
                  : error}
        </p>
      ) : null}
      <Popover
        anchor={showCard ? anchor : null}
        className="w-[420px] p-4"
        closeLabel="Close quick add"
        label={review ? 'Understood as' : 'Free slots'}
        onClose={close}
      >
        {review ? (
          <div className="flex flex-col gap-3" data-testid="quick-add-review">
            <div className="flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-xs font-semibold text-primary">
                <SparkleIcon size={14} />
                Understood as
              </span>
              <SegmentedControl
                label="Kind"
                onChange={setReviewKind}
                options={[
                  { label: 'Event', value: 'event' },
                  { label: 'Task', value: 'task' },
                ]}
                size="sm"
                value={review.kind}
              />
            </div>
            <div className="text-base font-semibold">{review.prefill.title}</div>
            <div className="flex flex-col gap-1 text-sm text-ink-secondary">
              <span>{reviewLine(review)}</span>
              <span className="flex items-center gap-1.5">
                {review.kind === 'event' ? (
                  <CalendarIcon size={14} />
                ) : (
                  <CheckCircleIcon size={14} />
                )}
                {review.kind === 'event'
                  ? calendarName
                  : (taskLists.find((list) => list.isVisible && !list.readOnly)?.title ??
                    'No list')}
              </span>
              {review.kind === 'event' && review.prefill.location ? (
                <span>{review.prefill.location}</span>
              ) : null}
            </div>
            <div className="flex justify-end gap-2">
              <Button
                data-testid="quick-add-edit"
                onClick={() => {
                  setAnchor(null);
                  confirmReview();
                }}
              >
                Edit details
              </Button>
              <Button data-testid="quick-add-confirm" onClick={addNow} variant="primary">
                {review.kind === 'event' ? 'Add event' : 'Add task'}
              </Button>
            </div>
          </div>
        ) : found ? (
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold text-primary">Free slots</span>
            <div className="flex flex-wrap gap-2">
              {found.slots.map((slot) => (
                <Button
                  key={`${slot.date}T${slot.startTime}`}
                  onClick={() => {
                    setAnchor(null);
                    pickSlot(slot);
                  }}
                  size="sm"
                >
                  {formatSlotLabel(slot)}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
      </Popover>
    </>
  );
}
