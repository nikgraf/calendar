import { makeFindSlots, type CaptureSource } from '@calendar/ai';
import { useModelAvailability, useQuickAddModel, type QuickAddItem } from '@calendar/app-state';
import { formatSlotLabel } from '@calendar/core';
import { useEffect, useRef } from 'react';
import { desktopLanguageModel } from '../ai/desktopModel.ts';
import { desktopSpeech } from '../ai/desktopSpeech.ts';
import { backend } from '../backend.ts';
import { Button } from '../ui/Button.tsx';
import { IconButton } from '../ui/IconButton.tsx';
import { MicIcon, SparkleIcon } from '../ui/icons.tsx';
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

/**
 * The editor's quick-add field, at the top of a new item: a phrase, typed
 * or dictated, fills the form below (Enter, Apply, or the end of a
 * dictation), on the bundled Foundation Models helper. Find a time lists
 * free slots; a picked one fills the event's day and times. The desktop
 * sibling of the iOS field: same model, same hand-off. Without the model
 * the field says so and the form below is still there.
 */
export function QuickAddBar({
  fallbackDate,
  focusSignal,
  onApply,
  onCapture,
  timeZone,
}: {
  /** Undated phrases land on this day (the editor's). */
  fallbackDate: string;
  /** ⌘K focuses the field: bumped per press. */
  focusSignal: number;
  onApply: (item: QuickAddItem) => void;
  /** A pasted email or image is not a phrase: it goes to capture. */
  onCapture: (source: CaptureSource) => void;
  timeZone: string;
}) {
  const { checking, retry, status } = useModelAvailability(desktopLanguageModel, onWindowFocus);
  const findSlotsRef = useRef(makeFindSlots(desktopLanguageModel, backend, timeZone));
  const inputRef = useRef<HTMLInputElement>(null);
  const {
    busy,
    error,
    found,
    mode,
    phrase,
    pickSlot,
    setMode,
    setPhrase,
    startRecording,
    stopRecording,
    submit,
    voice,
    voiceAvailable,
  } = useQuickAddModel({
    fallbackDate,
    findSlots: (text) => findSlotsRef.current(text),
    model: desktopLanguageModel,
    onApply,
    speech: desktopSpeech,
    timeZone,
  });
  const unavailable = status !== null && status !== 'ready';

  // Focused on open and on ⌘K — not while the model is missing, when the
  // title is the first thing to type into.
  useEffect(() => {
    if (!unavailable) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [focusSignal, unavailable]);

  const statusLine =
    voice === 'preparing'
      ? 'Preparing dictation…'
      : voice === 'recording'
        ? 'Listening — click the microphone when finished.'
        : voice === 'transcribing'
          ? 'Transcribing…'
          : busy
            ? mode === 'find'
              ? 'Looking for a slot…'
              : 'Reading…'
            : error;

  return (
    <div className="mb-3 flex flex-col gap-2" data-testid="quick-add">
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-primary">
          <SparkleIcon size={14} />
          {mode === 'find' ? 'Find a time' : 'Describe it'}
        </span>
        <SegmentedControl
          label="Quick-add mode"
          onChange={setMode}
          options={[
            { label: 'Add', value: 'add' },
            { label: 'Find time', value: 'find' },
          ]}
          size="sm"
          value={mode}
        />
      </div>
      <label
        className={`flex h-8 items-center gap-2 rounded-control bg-fill pr-1 pl-2.5 text-sm text-ink-secondary focus-within:ring-2 focus-within:ring-focus ${
          unavailable ? 'opacity-70' : ''
        }`}
        title={
          unavailable
            ? "The on-device model is unavailable — Solunivo's AI features need macOS 26 with Apple Intelligence enabled."
            : undefined
        }
      >
        <input
          aria-label={mode === 'find' ? 'Find a time' : 'Quick add'}
          className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-ink-secondary disabled:cursor-default"
          data-testid="quick-add-input"
          disabled={busy || unavailable}
          onChange={(input) => setPhrase(input.target.value)}
          onKeyDown={(key) => {
            if (key.key === 'Enter') {
              key.preventDefault();
              void submit();
            } else if (key.key === 'Escape') {
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
            data-testid="quick-add-mic"
            disabled={voice === 'preparing'}
            label={voice === 'recording' ? 'Stop dictating' : 'Dictate'}
            onClick={() => void (voice === 'recording' ? stopRecording() : startRecording())}
            size="sm"
          >
            <MicIcon />
          </IconButton>
        ) : null}
        {unavailable ? null : (
          <Button
            data-testid="quick-add-apply"
            disabled={busy || phrase.trim() === '' || voice === 'recording'}
            onClick={() => void submit()}
            size="sm"
            variant="primary"
          >
            {mode === 'find' ? 'Find' : 'Apply'}
          </Button>
        )}
      </label>
      {statusLine ? (
        <p className={`text-xs ${error ? 'text-danger' : 'text-ink-secondary'}`} role="status">
          {statusLine}
        </p>
      ) : null}
      {found ? (
        <div className="flex flex-col gap-2" data-testid="quick-add-slots">
          <span className="text-xs font-semibold text-primary">Free slots</span>
          <div className="flex flex-wrap gap-2">
            {found.slots.map((slot) => (
              <Button
                key={`${slot.date}T${slot.startTime}`}
                onClick={() => pickSlot(slot)}
                size="sm"
              >
                {formatSlotLabel(slot)}
              </Button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}
