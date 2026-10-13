import type { CaptureSource } from '@calendar/ai';
import { useModelAvailability, useQuickAddModel, type QuickAddItem } from '@calendar/app-state';
import { useEffect, useRef } from 'react';
import { desktopLanguageModel } from '../ai/desktopModel.ts';
import { desktopSpeech } from '../ai/desktopSpeech.ts';
import { modelUnavailableCopy } from '../ai/modelUnavailableCopy.ts';
import { Button } from '../ui/Button.tsx';
import { IconButton } from '../ui/IconButton.tsx';
import { MicIcon, SparkleIcon, SpinnerIcon } from '../ui/icons.tsx';
import { captureSourceOf, isCapturableInPhrase, readPaste } from './captureClipboard.ts';

/** The field's placeholder; the e2e specs find the field by it. */
export const QUICK_ADD_PLACEHOLDER = 'Lunch with Sarah tomorrow at 1';

/**
 * Re-check the model when the window regains focus (Apple Intelligence is
 * switched on in System Settings) and when the provider changes
 * (Settings › General picked another model while this editor was open).
 */
export const onWindowFocus = (onActive: () => void): (() => void) => {
  window.addEventListener('focus', onActive);
  const unsubscribe = window.calendarBridge.onModelProviderChanged(onActive);
  return () => {
    window.removeEventListener('focus', onActive);
    unsubscribe();
  };
};

/**
 * The editor's quick-add field, at the top of a new item: a phrase, typed
 * or dictated, fills the form below (Enter, Apply, or the end of a
 * dictation), on the bundled Foundation Models helper. The desktop
 * sibling of the iOS field: same model, same hand-off. Without the model
 * the field says why and the form below is still there. Find a time is
 * the event form's own tool (`FindTimeFields`).
 */
export function QuickAddBar({
  fallbackDate,
  focusSignal,
  onApply,
  onCapture,
  onPhrase,
  placeholder = QUICK_ADD_PLACEHOLDER,
  timeZone,
}: {
  /** Undated phrases land on this day (the editor's). */
  fallbackDate: string;
  /** ⌘K focuses the field: bumped per press. */
  focusSignal: number;
  onApply: (item: QuickAddItem) => void;
  /** A pasted email or image is not a phrase: it goes to capture. */
  onCapture: (source: CaptureSource) => void;
  /** The thread takes the phrase (a first phrase or a change) instead of the one-shot apply. */
  onPhrase?: ((text: string) => Promise<string | undefined>) | undefined;
  /** What the empty field says; a thread with drafts asks for a change. */
  placeholder?: string | undefined;
  timeZone: string;
}) {
  const { checking, retry, status } = useModelAvailability(desktopLanguageModel, onWindowFocus);
  const inputRef = useRef<HTMLInputElement>(null);
  const {
    busy,
    error,
    phrase,
    setPhrase,
    startRecording,
    stopRecording,
    submit,
    voice,
    voiceAvailable,
  } = useQuickAddModel({
    fallbackDate,
    model: desktopLanguageModel,
    onApply,
    onPhrase,
    speech: desktopSpeech,
    timeZone,
  });
  const unavailable = status !== null && status !== 'ready';
  const unavailableCopy = modelUnavailableCopy(status);

  // Focused on open and on ⌘K — not while the model is missing, when the
  // title is the first thing to type into.
  useEffect(() => {
    if (!unavailable) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [focusSignal, unavailable]);

  // Reading a phrase or transcribing one is shown in place — Apply turns
  // into a spinner of its own size and the microphone stays where it is —
  // so nothing under the field moves; a screen reader hears it instead.
  const working = busy || voice === 'transcribing';
  const workingCopy = voice === 'transcribing' ? 'Transcribing…' : busy ? 'Reading…' : '';
  const statusLine =
    voice === 'preparing'
      ? 'Preparing dictation…'
      : voice === 'recording'
        ? 'Listening — click the microphone when finished.'
        : working
          ? null
          : error;

  return (
    <div className="mb-3 flex flex-col gap-2" data-testid="quick-add">
      <span className="flex items-center gap-1.5 text-xs font-semibold text-primary">
        <SparkleIcon size={14} />
        Describe it
      </span>
      <label
        className={`flex h-8 items-center gap-2 rounded-control bg-fill pr-1 pl-2.5 text-sm text-ink-secondary focus-within:ring-2 focus-within:ring-focus ${
          unavailable ? 'opacity-70' : ''
        }`}
        title={unavailable ? unavailableCopy.long : undefined}
      >
        <input
          aria-label="Quick add"
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
            if (!isCapturableInPhrase(pasted)) {
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
          placeholder={unavailable ? unavailableCopy.short : placeholder}
          ref={inputRef}
          value={phrase}
        />
        {unavailable ? (
          <Button disabled={checking} onClick={retry} size="sm" variant="ghost">
            Retry
          </Button>
        ) : null}
        {voiceAvailable && !unavailable ? (
          <IconButton
            active={voice === 'recording'}
            className={voice === 'recording' ? 'text-danger' : ''}
            data-testid="quick-add-mic"
            disabled={working || voice === 'preparing'}
            label={voice === 'recording' ? 'Stop dictating' : 'Dictate'}
            onClick={() => void (voice === 'recording' ? stopRecording() : startRecording())}
            size="sm"
          >
            <MicIcon />
          </IconButton>
        ) : null}
        {unavailable ? null : (
          <Button
            aria-busy={working}
            className="relative"
            data-testid="quick-add-apply"
            disabled={working || phrase.trim() === '' || voice === 'recording'}
            onClick={() => void submit()}
            size="sm"
            variant="primary"
          >
            {/* The label keeps the button's width while the spinner stands in for it. */}
            <span className={working ? 'invisible' : ''}>Apply</span>
            {working ? <SpinnerIcon className="absolute" size={14} strokeWidth={2.25} /> : null}
          </Button>
        )}
      </label>
      <p className="sr-only" role="status">
        {workingCopy}
      </p>
      {statusLine ? (
        <p className={`text-xs ${error ? 'text-danger' : 'text-ink-secondary'}`} role="status">
          {statusLine}
        </p>
      ) : null}
    </div>
  );
}
